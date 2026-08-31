from app.security import get_password_hash
from app.database import SessionLocal
from app.models import User

email = 'admin@test.com'
new_password = 'password123'

db = SessionLocal()
try:
    user = db.query(User).filter(User.email == email).first()
    if user:
        user.hashed_password = get_password_hash(new_password)
        db.commit()
        print('Password updated successfully for:', email)
    else:
        print('User not found:', email)
finally:
    db.close()


