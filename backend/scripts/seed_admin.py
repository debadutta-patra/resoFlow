import sys
import os
import argparse
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Add the backend directory to python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SQLALCHEMY_DATABASE_URL
from app.models import User

engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def seed_admin(email: str):
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        if not user:
            print(f"Error: User with email '{email}' not found.")
            sys.exit(1)
        
        if user.is_superuser:
            print(f"User '{email}' is already a superuser.")
        else:
            user.is_superuser = True
            db.commit()
            print(f"Success! User '{email}' has been granted superuser status.")
    finally:
        db.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Grant superuser privileges to an existing user.")
    parser.add_argument("--email", required=True, help="The email address of the user to promote.")
    args = parser.parse_args()
    
    seed_admin(args.email)
