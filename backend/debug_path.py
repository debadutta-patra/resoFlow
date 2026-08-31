import os
import toml
import json

analysis_dir = "/home/debadutta/Documents/drb2d1_relaxation/high_conc/drb2d1/cest_fitting/785a5349-2366-43df-acc4-fb51a44a03af"
print(f"Checking directory: {analysis_dir}")
if not os.path.exists(analysis_dir):
    print("Analysis directory NOT FOUND")
else:
    print("Analysis directory FOUND")
    output_dir = os.path.join(analysis_dir, "Output")
    print(f"Checking Output directory: {output_dir}")
    if os.path.exists(output_dir):
        print(f"Contents of {output_dir}: {os.listdir(output_dir)}")
    else:
         print("Output directory NOT FOUND")
