"""In-process license guard — reference client for Python / FastAPI / Starlette services.

This verifies the license *inside the application process*, using the same algorithm, the
same signed license file, and the same public key as the sidecar gate. Unlike the gate, this
cannot be skipped by running the container directly — the app itself refuses to serve.

Integrate (one line after creating the app):

    from license_guard import LicenseMiddleware
    app.add_middleware(LicenseMiddleware)            # optionally: allow=("/health",)

Inputs (same as the gate), via env with sensible defaults:
    LICENSE_PUBLIC_KEY_PATH   baked-in vendor public key   (default /app/public.pem)
    LICENSE_FILE              shared, imported license     (default /data/license.lic)
    LICENSE_MACHINE_ID_PATH   mounted host machine-id      (default /host/machine-id)

Fail-closed: any request is answered 403 while the license is missing/invalid/expired.
For real distribution, publish this as an internal package and compile it (Cython/Nuitka)
so the check can't be trivially patched out.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from datetime import datetime, timezone

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

PUBLIC_KEY_PATH = os.environ.get("LICENSE_PUBLIC_KEY_PATH", "/app/public.pem")
LICENSE_FILE = os.environ.get("LICENSE_FILE", "/data/license.lic")
MACHINE_ID_PATH = os.environ.get("LICENSE_MACHINE_ID_PATH", "/host/machine-id")
_DAY = 86_400.0  # seconds

_public_key = None
_fingerprint: str | None = None
_cache = {"mtime": -1.0, "claims": None}


def _pub():
    global _public_key
    if _public_key is None:
        with open(PUBLIC_KEY_PATH, "rb") as f:
            _public_key = load_pem_public_key(f.read())
    return _public_key


def fingerprint() -> str | None:
    """sha256('amh-license-v1:' + host machine-id), 32 hex upper, grouped in 4s. Matches the gate/CLI."""
    global _fingerprint
    if _fingerprint is not None:
        return _fingerprint
    try:
        with open(MACHINE_ID_PATH) as f:
            mid = f.read().strip()
        if mid:
            h = hashlib.sha256(f"amh-license-v1:{mid}".encode()).hexdigest()[:32].upper()
            _fingerprint = "-".join(h[i : i + 4] for i in range(0, 32, 4))
    except OSError:
        _fingerprint = None
    return _fingerprint


def _load_claims():
    """Re-read + re-verify only when the license file changes (cheap stat on the hot path)."""
    try:
        st = os.stat(LICENSE_FILE)
    except OSError:
        _cache.update(mtime=-1.0, claims=None)
        return None
    if st.st_mtime == _cache["mtime"]:
        return _cache["claims"]
    claims = None
    try:
        with open(LICENSE_FILE) as f:
            doc = json.load(f)
        _pub().verify(base64.b64decode(doc["signature"]), doc["payload"].encode())  # raises if bad
        claims = json.loads(base64.b64decode(doc["payload"]))
    except (InvalidSignature, KeyError, ValueError, OSError):
        claims = None
    _cache.update(mtime=st.st_mtime, claims=claims)
    return claims


def get_status(now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    now_ts = now.timestamp()
    c = _load_claims()
    if not c:
        return {"valid": False, "code": "NO_LICENSE", "message": "No valid license installed"}
    if c.get("fingerprint") != fingerprint():
        return {"valid": False, "code": "MACHINE_MISMATCH", "message": "License issued for a different machine"}
    exp = datetime.fromisoformat(c["expiresAt"].replace("Z", "+00:00")).timestamp()
    grace_end = exp + float(c.get("graceDays", 0)) * _DAY
    if now_ts > grace_end:
        return {"valid": False, "code": "EXPIRED", "message": "License has expired", "expiresAt": c["expiresAt"]}
    if now_ts > exp:
        return {"valid": True, "code": "GRACE", "message": "License in grace period", "expiresAt": c["expiresAt"]}
    return {"valid": True, "code": "VALID", "message": "License valid", "expiresAt": c["expiresAt"]}


class LicenseMiddleware(BaseHTTPMiddleware):
    """Reject every request with 403 while the license is invalid. `allow` skips path prefixes."""

    def __init__(self, app, allow: tuple[str, ...] = ()):
        super().__init__(app)
        self.allow = tuple(allow)

    async def dispatch(self, request, call_next):
        if any(request.url.path.startswith(p) for p in self.allow):
            return await call_next(request)
        s = get_status()
        if not s["valid"]:
            return JSONResponse(
                {"error": "LICENSE_INVALID", "code": s["code"], "message": s["message"]}, status_code=403
            )
        response = await call_next(request)
        response.headers["X-License-Status"] = s["code"]
        return response
