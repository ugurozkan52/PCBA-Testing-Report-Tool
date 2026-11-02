#!/usr/bin/env python3
"""Plugin export pipeline test (no KiCad GUI): python3 test/kicad/test_plugin.py <work dir>"""
import json, os, shutil, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'kicad-plugin'))
from montaj_kicad import exporter  # noqa: E402

work = sys.argv[1] if len(sys.argv) > 1 else '/tmp/montaj-kicad-test'
shutil.rmtree(work, ignore_errors=True)
proj = os.path.join(work, 'Güç Kartı')
os.makedirs(os.path.join(proj, 'sub'))
pcb = os.path.join(proj, 'GUC_KARTI.kicad_pcb')
open(pcb, 'w').write('(kicad_pcb (version 20250000))')
open(os.path.join(proj, 'GUC_KARTI.kicad_sch'), 'w', encoding='utf-8').write(
    '(kicad_sch (symbol (property "Reference" "R1") (property "Value" "10k") (property "Description" "x") (property "Manufacturer" "Y"))\n'
    ' (sheet (property "Sheetname" "Güç") (property "Sheetfile" "sub/guc.kicad_sch")))')
open(os.path.join(proj, 'sub', 'guc.kicad_sch'), 'w', encoding='utf-8').write('(kicad_sch (symbol (property "MPN" "ABC-1")))')
os.environ['FAKE_CLI_LOG'] = os.path.join(work, 'calls.jsonl')
cfg = {'kicad_cli': os.path.join(HERE, 'kicad-cli'), 'export_step': True}
steps = []
job = exporter.export_all(pcb, title='Güç Kartı', revision='B', company='Anova', cfg=cfg,
                          progress=lambda m, f=None: steps.append(m), lang='tr')
calls = [json.loads(l) for l in open(os.environ['FAKE_CLI_LOG'], encoding='utf-8')]
work_calls = [c for c in calls if '--help' not in c]
assert [c[:3] for c in work_calls] == [['pcb', 'export', 'ipc2581'], ['sch', 'export', 'bom'], ['pcb', 'export', 'step']], work_calls
ipc, bom, step = work_calls
assert ipc[ipc.index('--units') + 1] == 'mm' and ipc[ipc.index('--bom-col-mfg-pn') + 1] == 'MPN' and ipc[ipc.index('--bom-col-mfg') + 1] == 'Manufacturer', ipc
assert bom[bom.index('--fields') + 1] == 'Reference,Value,Footprint,QUANTITY,Description,Manufacturer,MPN', bom
assert bom[bom.index('--ref-range-delimiter') + 1] == '' and '--exclude-dnp' in bom and bom[bom.index('--group-by') + 1] == 'Value,Footprint,MPN', bom
assert all(f in step for f in ('--subst-models', '--force', '--no-dnp')), step
dd = os.path.join(proj, 'docs', 'montaj')
assert job['dataDir'] == dd and os.path.isfile(job['jobFile']) and job['jobFile'] == os.path.join(dd, 'kicad-job.json')
for k in ('ipcFile', 'bomFile', 'stepFile'):
    assert job[k] and os.path.isfile(job[k]) and job[k].startswith(os.path.join(dd, 'kicad-export')), (k, job[k])
saved = json.load(open(job['jobFile'], encoding='utf-8'))
assert saved['kind'] == 'montaj-kicad-job' and saved['title'] == 'Güç Kartı' and saved['revision'] == 'B'
assert {'IPC-2581', 'BOM', 'STEP 3D'} <= set(steps)
# a failing STEP export must not stop the job
os.environ['FAKE_CLI_FAIL'] = 'pcb/export/step'
job2 = exporter.export_all(pcb, title='Güç Kartı', cfg=cfg, lang='tr')
assert job2['stepFile'] is None and any(w.startswith('STEP') for w in job2['warnings']), job2
del os.environ['FAKE_CLI_FAIL']
# a failing IPC export is an error
os.environ['FAKE_CLI_FAIL'] = 'pcb/export/ipc2581'
try:
    exporter.export_all(pcb, cfg=cfg); raise SystemExit('expected ExportError')
except exporter.ExportError as e:
    assert 'IPC-2581' in str(e)
del os.environ['FAKE_CLI_FAIL']
# STEP written with VRML warnings and a non-zero exit code is still a valid STEP
os.environ['FAKE_STEP_WARN'] = '1'
job3 = exporter.export_all(pcb, title='Güç Kartı', cfg=cfg, lang='tr')
assert job3['stepFile'] and not job3['warnings'] and any('VRML' in n for n in job3['notes']), (job3['warnings'], job3['notes'])
del os.environ['FAKE_STEP_WARN']
job = exporter.export_all(pcb, title='Güç Kartı', revision='B', company='Anova', cfg=cfg, lang='tr')
print('OK plugin exporter', job['jobFile'])
