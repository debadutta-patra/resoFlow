with open("frontend/src/pages/ProjectDetails.tsx", "r") as f:
    lines = f.readlines()

new_lines = []
for i, line in enumerate(lines):
    if "type: 'CPMG" in line:
        pass
    if "type: 'EXCHANGE" in line:
        continue
    if "Layers className" in line or "Exchange</span>" in line or "<button " in line:
        # Actually, let's just restore the file from git and apply a python script.
        pass
