import sys
import os
import argparse
from pathlib import Path

# Add backend to sys.path
backend_path = Path(__file__).resolve().parent / "backend"
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

# Ensure default DATABASE_URL is set for PostgreSQL container if not in environment
if "DATABASE_URL" not in os.environ:
    os.environ["DATABASE_URL"] = "postgresql://resoflow:resoflow@localhost:5432/resoflow"

from app.security import get_password_hash
from app.database import SessionLocal
from app.models import User

def reset_or_create_user(email: str, password: str, make_admin: bool = False):
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        if user:
            user.hashed_password = get_password_hash(password)
            user.is_active = True
            if make_admin:
                user.is_superuser = True
            db.commit()
            print(f"✓ Password updated successfully for: {email}")
            print(f"  Status: Active={user.is_active}, Admin={user.is_superuser}")
        else:
            user = User(
                email=email,
                hashed_password=get_password_hash(password),
                full_name=email.split("@")[0].capitalize(),
                is_active=True,
                is_superuser=make_admin
            )
            db.add(user)
            db.commit()
            print(f"✓ User created successfully: {email}")
            print(f"  Status: Active=True, Admin={make_admin}")
    finally:
        db.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Reset password or create an active user in resoFlow.")
    parser.add_argument("--email", default="admin@test.com", help="User email address (default: admin@test.com)")
    parser.add_argument("--password", default="test_password", help="New password (default: test_password)")
    parser.add_argument("--admin", action="store_true", help="Grant superuser / admin privileges")
    args = parser.parse_args()

    reset_or_create_user(args.email, args.password, make_admin=args.admin or (args.email == "admin@test.com"))



