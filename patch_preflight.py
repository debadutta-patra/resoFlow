import re

with open("backend/app/routers/exchange.py", "r") as f:
    content = f.read()

bad_cmd = """    cmd = [
        "podman", "run", "--rm", "--userns=keep-id",
        "-v", f"{to_host_path(preflight_dir)}:/work:z",
        DEFAULT_CHEMEX_IMAGE,
        "--entrypoint", "python",
        "-m", "resoflow.preflight", "--json", "-e"
    ]"""

good_cmd = """    cmd = [
        "podman", "run", "--rm", "--userns=keep-id",
        "--entrypoint", "python",
        "-v", f"{to_host_path(preflight_dir)}:/work:z",
        DEFAULT_CHEMEX_IMAGE,
        "-m", "resoflow.preflight", "--json", "-e"
    ]"""

content = content.replace(bad_cmd, good_cmd)

with open("backend/app/routers/exchange.py", "w") as f:
    f.write(content)
