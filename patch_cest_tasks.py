import re

with open("backend/app/services/fitting/cest_tasks.py", "r") as f:
    content = f.read()

content = content.replace(
    'sec_name = p_sec.split(",")[0].lower().strip().strip(\'"\')',
    'sec_name = p_sec.lower().strip().strip(\'"\')'
)

with open("backend/app/services/fitting/cest_tasks.py", "w") as f:
    f.write(content)
