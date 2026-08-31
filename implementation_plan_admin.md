# Admin Dashboard & User Management Implementation Plan

This plan details the steps to build a user administration panel, allowing superusers to view and manage accounts on the platform.

## Proposed Changes

### Backend Database & Schemas
#### [MODIFY] `backend/app/models.py`
- Add `is_superuser = Column(Boolean, default=False)` to the `User` model.

#### [MODIFY] `backend/app/schemas.py`
- Update `User` schema to include `is_superuser: bool`.
- Create `UserUpdate` schema for updating user active/superuser status.

#### [NEW] `backend/scripts/seed_admin.py`
- Create a standalone python script that connects to the database via SQLAlchemy to create an initial admin user (or upgrade an existing user based on email).

### Backend Security & API
#### [MODIFY] `backend/app/security.py`
- Add a dependency `get_current_active_superuser(current_user: User = Depends(get_current_user))` that raises a 403 Forbidden HTTP exception if `is_superuser` is false.

#### [NEW] `backend/app/routers/admin.py`
- **GET `/api/admin/users`**: Lists all users for the admin dashboard. Protected by `get_current_active_superuser`.
- **PUT `/api/admin/users/{user_id}/status`**: Toggle `is_active` or `is_superuser` for a user.

#### [MODIFY] `backend/app/main.py`
- Include the new `admin.router`.

### Frontend Application
#### [MODIFY] `frontend/src/context/AuthContext.tsx`
- Update the `User` TypeScript interface: `is_superuser: boolean;`

#### [MODIFY] `frontend/src/App.tsx`
- Create a new `{ children }` route wrapper component called `<AdminRoute>` that checks `isAuthenticated && user?.is_superuser`. If false, redirects to `/dashboard`.
- Add a new route `<Route path="/admin" element={<AdminRoute><AdminDashboard /></AdminRoute>} />`.

#### [MODIFY] `frontend/src/pages/Dashboard.tsx`
- Add a navigation link in the top right navbar that points to "Admin Panel" and is only visible when `user?.is_superuser` is true.

#### [NEW] `frontend/src/pages/AdminDashboard.tsx`
- Build a full-page layout using modern TailwindCSS.
- Fetch users from `/api/admin/users`.
- Display a data table showing User ID, Name, Email, Status (Active/Inactive labels), and Superuser flags.
- Include action buttons to:
  - Deactivate/Activate user accounts.
  - Promote/Demote admins (with safeguards against demoting oneself).

## Verification Plan

### Manual Verification
1. Run `uv run backend/scripts/seed_admin.py --email <target_email>` to grant admin to an existing user via the backend terminal.
2. Log in with the target user to the frontend.
3. Assert that the "Admin Panel" link appears in the main navigation.
4. Click the link to navigate to `/admin`.
5. Assert that the table of users lists all registered accounts properly.
6. Register a new dummy user in an incognito window, observe them appear on the dashboard.
7. Click "Deactivate" on the dummy user from the Admin Panel. 
8. Attempt to login as the deactivated dummy user, expecting a 400 error stating the user is deactivated.
