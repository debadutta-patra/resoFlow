import re

with open("backend/app/routers/analysis.py", "r") as f:
    content = f.read()

bad_return = """    # Update analysis parameters for frontend
    params = analysis.parameters_dict"""

good_return = """    # Update analysis parameters for frontend
    params = json.loads(analysis.parameters) if analysis.parameters else {}"""

content = content.replace(bad_return, good_return)

with open("backend/app/routers/analysis.py", "w") as f:
    f.write(content)
