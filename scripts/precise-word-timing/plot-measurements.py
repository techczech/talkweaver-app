"""Export a static comparison figure; no audio/model access."""
import os,pathlib,json
root=pathlib.Path(__file__).resolve().parents[2]
os.environ['MPLCONFIGDIR']=str(root/'scripts/precise-word-timing/local/matplotlib')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
folder=root/'docs/design/2026-11-10-record-and-edit-video/built/slice-2b'
data=json.loads((folder/'shipping-candidate-measurements.json').read_text())['languages']
plt.rcParams.update({'font.size':11,'axes.spines.top':False,'axes.spines.right':False})
fig,axes=plt.subplots(1,2,figsize=(10,4.8),layout='constrained',sharey=True)
for ax,cohort,title in zip(axes,['confidentAligned','includingOriginalFallback'],['Confident aligned boundaries','All boundaries, including original fallback']):
 values=[data[lang][cohort]['clipOver80Percent'] for lang in ['English','Czech']]
 counts=[data[lang][cohort]['pairs'] for lang in ['English','Czech']]
 bars=ax.bar([0,1],values,width=.55,color=['#286b9a','#b35b20'])
 ax.bar_label(bars,labels=[f'{v:.2f}%' for v in values],padding=5,fontsize=12)
 ax.set_xticks([0,1],[f'English ({counts[0]} pairs)',f'Czech ({counts[1]} pairs)'])
 ax.set_title(title,loc='left',fontsize=12,fontweight='bold')
 ax.set_ylabel('Clipping beyond 80 ms (%)')
 ax.set_ylim(0,5);ax.yaxis.grid(True,alpha=.2);ax.set_axisbelow(True)
 ax.axhline(2,color='#555',linestyle='--',linewidth=1,label='2% target')
 ax.legend(loc='upper right',fontsize=9,frameon=False)
fig.suptitle('Precise word timing: aligned cuts and remaining fallback risk',fontsize=14,fontweight='bold')
fig.supxlabel('INT8 ONNX models. Aligned coverage: English 90.39%, Czech 82.24%.\nFrozen public reference pairs; zero missing. Reference estimates, not listening judgements.',fontsize=9)
fig.savefig(folder/'cut-timing-comparison.png',dpi=170)
