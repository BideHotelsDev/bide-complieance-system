"""Password hashes for the break-glass admin sign-in (auth.admin_password). scrypt from the standard library.

`python -m bide_comply.passwords` makes a long random password and its hash. The hash goes in ADMIN_LOGIN_PASSWORD_HASH;
the password is written to the file named on the command line (or printed when none is given), never to the database.
"""

import base64
import hashlib
import hmac
import secrets
import sys
from pathlib import Path

N, R, P = 2**15, 8, 1


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=N, r=R, p=P, maxmem=2**26, dklen=32)
    return f"scrypt${N}${R}${P}${_b64(salt)}${_b64(dk)}"


def verify(password: str, stored: str) -> bool:
    try:
        kind, n, r, p, salt, want = stored.split("$")
        if kind != "scrypt":
            return False
        dk = hashlib.scrypt(
            password.encode(), salt=_unb64(salt), n=int(n), r=int(r), p=int(p), maxmem=2**26, dklen=len(_unb64(want))
        )
    except ValueError:
        return False
    return hmac.compare_digest(dk, _unb64(want))


def generate() -> str:
    # 24 characters from letters and digits, in groups of 6 so it can be typed.
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(24))
    return "-".join(raw[i : i + 6] for i in range(0, 24, 6))


if __name__ == "__main__":
    pw = generate()
    if len(sys.argv) > 1:
        out = Path(sys.argv[1])
        out.write_text(pw + "\n")
        out.chmod(0o600)
        print(f"Password written to {out}.")
    else:
        print(f"Password: {pw}")
    print(f"ADMIN_LOGIN_PASSWORD_HASH={hash_password(pw)}")
