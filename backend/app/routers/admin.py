from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from .. import models, schemas, database, security

router = APIRouter(prefix="/api/admin", tags=["admin"])

@router.get("/users", response_model=List[schemas.User])
def read_users(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_active_superuser)
):
    """
    Retrieve users. Only accessible by superusers.
    """
    users = db.query(models.User).offset(skip).limit(limit).all()
    return users

@router.put("/users/{user_id}/status", response_model=schemas.User)
def update_user_status(
    user_id: int,
    user_update: schemas.UserUpdate,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_active_superuser)
):
    """
    Update a user's active or superuser status. Only accessible by superusers.
    Prevents a superuser from modifying their own superuser status to avoid lockout.
    """
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    if user_update.is_superuser is not None:
        if current_user.id == user_id and current_user.is_superuser and not user_update.is_superuser:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail="Cannot demote yourself from superuser status."
            )
        user.is_superuser = user_update.is_superuser
        
    if user_update.is_active is not None:
        if current_user.id == user_id and not user_update.is_active:
             raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail="Cannot deactivate your own account."
            )
        user.is_active = user_update.is_active

    db.commit()
    db.refresh(user)
    return user

@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: int,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_active_superuser)
):
    """
    Delete a user. Only accessible by superusers.
    Prevents a superuser from deleting their own account.
    """
    if current_user.id == user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, 
            detail="Cannot delete your own account."
        )
        
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    db.delete(user)
    db.commit()
    return None

@router.put("/users/{user_id}/password", response_model=schemas.User)
def change_user_password(
    user_id: int,
    password_update: schemas.UserPasswordUpdate,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_active_superuser)
):
    """
    Change a user's password. Only accessible by superusers.
    """
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    user.hashed_password = security.get_password_hash(password_update.new_password)
    db.commit()
    db.refresh(user)
    return user
