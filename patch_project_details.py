with open("frontend/src/pages/ProjectDetails.tsx", "r") as f:
    content = f.read()

cpmg_btn = """                      <button
                        type="button"
                        onClick={() => setNewAnalysisData({...newAnalysisData, type: 'CPMG'})}
                        className={`px-3 py-3 rounded-xl border-2 transition-all flex flex-col items-center justify-center ${newAnalysisData.type === 'CPMG' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-slate-100 dark:border-slate-700 text-slate-500 hover:border-slate-300 dark:hover:border-slate-600'}`}
                      >
                        <span className="font-bold text-base">CPMG</span>
                        <span className="text-[10px] uppercase font-bold tracking-wider opacity-60">CPMG</span>
                      </button>"""

exchange_btn = """                      <button
                        type="button"
                        onClick={() => setNewAnalysisData({...newAnalysisData, type: 'EXCHANGE'})}
                        className={`px-3 py-3 rounded-xl border-2 transition-all flex flex-col items-center justify-center ${newAnalysisData.type === 'EXCHANGE' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-slate-100 dark:border-slate-700 text-slate-500 hover:border-slate-300 dark:hover:border-slate-600'}`}
                      >
                        <span className="font-bold text-base">Exchange</span>
                        <span className="text-[10px] uppercase font-bold tracking-wider opacity-60">Combined</span>
                      </button>"""

content = content.replace(cpmg_btn, cpmg_btn + "\n" + exchange_btn)

with open("frontend/src/pages/ProjectDetails.tsx", "w") as f:
    f.write(content)
