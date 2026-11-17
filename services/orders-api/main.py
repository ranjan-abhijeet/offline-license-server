from fastapi import FastAPI, Request
from license_guard import LicenseMiddleware

# Caddy strips the /orders prefix (handle_path); root_path keeps /docs links correct.
app = FastAPI(title="orders-api", root_path="/orders")

# In-process license enforcement: the app itself refuses to serve without a valid license,
# even if someone runs this container directly and bypasses the sidecar gate. One line.
app.add_middleware(LicenseMiddleware)

ORDERS = [
    {"id": 1, "item": "PUMP-001", "qty": 2},
    {"id": 2, "item": "VALVE-204", "qty": 10},
]


@app.get("/")
def root(request: Request):
    return {
        "service": "orders-api (FastAPI)",
        "license_status": request.headers.get("x-license-status"),
        "license_expires": request.headers.get("x-license-expires"),
    }


@app.get("/items")
def items():
    return ORDERS
