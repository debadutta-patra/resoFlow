import os
import sys
import sqlite3
import getpass

# Get the absolute path of the 'backend' directory
# This script is in 'backend/create_superuser.py'
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

try:
    from app import security, models
    from app.database import SessionLocal
except ImportError as e:
    print(f"Error importing app modules: {e}")
    print("\nTip: Make sure you are running this from the project root or the backend directory.")
    print("If you are using 'uv', try: uv run python backend/create_superuser.py")
    sys.exit(1)

def create_superuser():
    print("--- resoFlow Superuser Creation ---")

    email = input("Email: ").strip()
    full_name = input("Full Name: ").strip()
    password = getpass.getpass("Password: ")
    confirm_password = getpass.getpass("Confirm Password: ")
    
    if password != confirm_password:
        print("Error: Passwords do not match.")
        return

    hashed_password = security.get_password_hash(password)
    
    db = SessionLocal()
    try:
        existing = db.query(models.User).filter(models.User.email == email).first()
        if existing:
            print(f"\nError: A user with email '{email}' already exists.")
            return

        user = models.User(
            email=email,
            hashed_password=hashed_password,
            full_name=full_name,
            is_active=True,
            is_superuser=True
        )
        db.add(user)
        db.commit()
        print(f"\nSUCCESS: Superuser '{email}' created successfully.")
    except Exception as e:
        db.rollback()
        print(f"\nError occurred: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    create_superuser()

