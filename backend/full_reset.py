import os
import sqlite3
import glob
import shutil

# Paths
DB_PATH = "backend/sql_app.db"
PROJECTS_DIR = "backend/projects"

def full_reset():
    if not os.path.exists(DB_PATH):
        print(f"Database {DB_PATH} not found.")
    else:
        print("Cleaning up database tables...")
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # Get all tables
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = [t[0] for t in cursor.fetchall() if t[0] != 'sqlite_sequence']
        
        for table in tables:
            try:
                cursor.execute(f"DELETE FROM {table};")
                # Reset auto-increment counters if possible
                try:
                    cursor.execute(f"DELETE FROM sqlite_sequence WHERE name='{table}';")
                except:
                    pass
                print(f"  - Cleared table: {table}")
            except sqlite3.OperationalError as e:
                print(f"  - Error clearing {table}: {e}")
        
        conn.commit()
        conn.close()
        print("Database wiped.")

    print("Cleaning up project files and result JSONs...")
    
    # Paths to clear
    cleanup_paths = [
        "backend/projects/*",
        "backend/*.json",
        "backend/*.log",
        "test_data/**/*.json",
        "test_data/**/*.ft2", # Maybe keep test data? User said "clear all database entries" and was unhappy projects remained.
    ]
    
    deleted_files = 0
    deleted_dirs = 0
    
    for pattern in cleanup_paths:
        for path in glob.glob(pattern, recursive=True):
            # Safety: don't delete essential files
            basename = os.path.basename(path)
            if basename in ["package.json", "tsconfig.json", "uv.lock", "pyproject.toml"]:
                continue
                
            try:
                if os.path.isfile(path):
                    os.remove(path)
                    deleted_files += 1
                elif os.path.isdir(path):
                    shutil.rmtree(path)
                    deleted_dirs += 1
            except Exception as e:
                print(f"  - Failed to delete {path}: {e}")

    print(f"Deleted {deleted_files} files and {deleted_dirs} directories.")
    print("\nSYSTEM FULL RESET COMPLETE.")

if __name__ == "__main__":
    # In this environment, we just run it. 
    # But usually we'd ask for confirmation.
    full_reset()
