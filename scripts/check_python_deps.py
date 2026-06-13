import sys

try:
    import serial  # noqa: F401
    from serial.tools import list_ports  # noqa: F401
except Exception:
    print("missing:pyserial")
    sys.exit(1)
print("ok")
