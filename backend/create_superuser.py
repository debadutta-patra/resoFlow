import argparse
import getpass
import os
import sys

# Get the absolute path of the 'backend' directory
# This script is in 'backend/create_superuser.py'
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

try:
    from app import models, security
    from app.database import SessionLocal
except ImportError as e:
    print(f"Error importing app modules: {e}")
    print("\nTip: Make sure you are running this from the project root or the backend directory.")
    print("If you are using 'uv', try: uv run python backend/create_superuser.py")
    sys.exit(1)


def create_or_update_superuser(
    email: str,
    password: str,
    full_name: str = "Administrator",
) -> bool:
    email = email.strip()
    if not email:
        print("Error: Email cannot be empty.", file=sys.stderr)
        return False
    if not password:
        print("Error: Password cannot be empty.", file=sys.stderr)
        return False

    hashed_password = security.get_password_hash(password)
    db = SessionLocal()
    try:
        existing = db.query(models.User).filter(models.User.email == email).first()
        if existing:
            existing.hashed_password = hashed_password
            if full_name:
                existing.full_name = full_name
            existing.is_active = True
            existing.is_superuser = True
            db.commit()
            print(f"SUCCESS: Superuser '{email}' updated and activated successfully.")
            return True

        user = models.User(
            email=email,
            hashed_password=hashed_password,
            full_name=full_name or "Administrator",
            is_active=True,
            is_superuser=True,
        )
        db.add(user)
        db.commit()
        print(f"SUCCESS: Superuser '{email}' created successfully.")
        return True
    except Exception as e:
        db.rollback()
        print(f"Error creating superuser: {e}", file=sys.stderr)
        return False
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description="Create or update a resoFlow administrator/superuser account.")
    parser.add_argument("--email", "-e", help="Administrator email address", default=os.getenv("ADMIN_EMAIL"))
    parser.add_argument("--password", "-p", help="Administrator password", default=os.getenv("ADMIN_PASSWORD"))
    parser.add_argument("--name", "-n", help="Administrator full name", default=os.getenv("ADMIN_NAME", "Administrator"))
    parser.add_argument("--non-interactive", action="store_true", help="Fail instead of prompting if parameters are missing")

    args = parser.parse_args()

    email = args.email
    password = args.password
    full_name = args.name

    if not email or not password:
        if args.non_interactive:
            print("Error: --email and --password are required in non-interactive mode.", file=sys.stderr)
            sys.exit(1)

        print("--- resoFlow Superuser Creation ---")
        if not email:
            email = input("Email: ").strip()
        if not full_name or full_name == "Administrator":
            name_input = input(f"Full Name [{full_name}]: ").strip()
            if name_input:
                full_name = name_input
        if not password:
            password = getpass.getpass("Password: ")
            confirm_password = getpass.getpass("Confirm Password: ")
            if password != confirm_password:
                print("Error: Passwords do not match.", file=sys.stderr)
                sys.exit(1)

    success = create_or_update_superuser(email=email, password=password, full_name=full_name)
    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()


