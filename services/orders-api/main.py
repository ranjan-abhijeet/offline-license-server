from fastapi import FastAPI, Request

# Caddy strips the /orders prefix (handle_path); root_path keeps /docs links correct.
app = FastAPI(title="orders-api", root_path="/orders")

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
