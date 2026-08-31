import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from playwright.async_api import async_playwright
from app import security

ARTIFACT_DIR = Path("/home/debadutta/.gemini/antigravity/brain/3153dee0-47c7-4f70-b041-f305c175ad4a")
STEP1_PNG = ARTIFACT_DIR / "step1_grid_search.png"
STEP2_PNG = ARTIFACT_DIR / "step2_no_grid.png"

async def main():
    token = security.create_access_token({"sub": "admin@test.com"})
    user_json = json.dumps({"id": 2, "email": "admin@test.com", "full_name": "Admin User", "is_active": True, "is_admin": True})

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 1100})
        page = await context.new_page()

        page.on("console", lambda msg: print(f"[Browser Console {msg.type}]: {msg.text}"))
        page.on("pageerror", lambda err: print(f"[Browser Error]: {err}"))

        # Pre-set localStorage authentication tokens
        await page.goto("http://localhost:5173/login")
        await page.evaluate(f"""() => {{
            localStorage.setItem('token', '{token}');
            localStorage.setItem('user', '{user_json}');
        }}""")

        # Navigate to STEP1 Analysis page
        target_url = "http://localhost:5173/projects/2e4241b323074cddbdc5ddc27ae19a8c/analysis/ba38acbb-3055-4a52-a228-9977a0d8d903?step=STEP1"
        print(f"Navigating to {target_url}...")
        await page.goto(target_url, wait_until="networkidle")
        await page.wait_for_timeout(4000)

        # Capture STEP1 with Grid Search section
        print(f"Capturing STEP1 screenshot to {STEP1_PNG}...")
        await page.screenshot(path=str(STEP1_PNG), full_page=True)

        # Switch to STEP2
        target_url_step2 = "http://localhost:5173/projects/2e4241b323074cddbdc5ddc27ae19a8c/analysis/ba38acbb-3055-4a52-a228-9977a0d8d903?step=STEP2"
        print(f"Navigating to {target_url_step2}...")
        await page.goto(target_url_step2, wait_until="networkidle")
        await page.wait_for_timeout(4000)

        # Capture STEP2 where Grid Search section disappears cleanly
        print(f"Capturing STEP2 screenshot to {STEP2_PNG}...")
        await page.screenshot(path=str(STEP2_PNG), full_page=True)

        await browser.close()
        print("Screenshots captured successfully!")

if __name__ == "__main__":
    asyncio.run(main())
