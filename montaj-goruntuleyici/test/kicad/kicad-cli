#!/usr/bin/env python3
"""Stand-in for kicad-cli (KiCad 10 flag set) used by the plugin tests.
Writes the test IPC-2581 / BOM / STEP files and records each call in calls.jsonl."""
import csv, json, os, shutil, sys
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
a = sys.argv[1:]
with open(os.environ.get('FAKE_CLI_LOG', os.path.join(HERE, 'calls.jsonl')), 'a', encoding='utf-8') as f:
    f.write(json.dumps(a, ensure_ascii=False) + '\n')
HELP = {
    ('pcb', 'export', 'ipc2581'): "Usage: ipc2581 [--help] [--output OUTPUT_FILE] [--drawing-sheet SHEET_PATH] [--define-var KEY=VALUE] [--variant VARIANT] [--precision PRECISION] [--compress] [--version VAR] [--units VAR] [--bom-col-int-id FIELD_NAME] [--bom-col-mfg-pn FIELD_NAME] [--bom-col-mfg FIELD_NAME] [--bom-col-dist-pn FIELD_NAME] [--bom-col-dist FIELD_NAME] [--bom-rev REVISION] [--ref-des VAR] input\nExport the PCB in IPC-2581 format",
    ('sch', 'export', 'bom'): "Usage: bom [--help] [--output OUTPUT_FILE] [--preset PRESET] [--format-preset FMT_PRESET] [--fields FIELDS] [--labels LABELS] [--group-by GROUP_BY] [--sort-field SORT_BY] [--sort-asc] [--filter FILTER] [--exclude-dnp] [--field-delimiter FIELD_DELIM] [--string-delimiter STR_DELIM] [--ref-delimiter REF_DELIM] [--ref-range-delimiter REF_RANGE_DELIM] [--keep-tabs] [--keep-line-breaks] input\n --fields  An ordered list of fields to export. Generated fields such as QUANTITY and DNP",
    ('pcb', 'export', 'step'): "Usage: step [--help] [--output OUTPUT_FILE] [--define-var KEY=VALUE] [--force] [--grid-origin] [--drill-origin] [--no-unspecified] [--no-dnp] [--subst-models] [--board-only] [--include-tracks] [--include-pads] [--include-zones] [--include-inner-copper] [--include-silkscreen] [--include-soldermask] [--fuse-shapes] [--fill-all-vias] [--min-distance MIN_DIST] [--net-filter VAR] [--no-board-body] [--no-components] [--cut-vias-in-body] [--no-optimize-step] input",
}
key = tuple(a[:3])
if '--help' in a:
    print(HELP.get(key, 'Usage: kicad-cli')); sys.exit(0)
out = a[a.index('-o') + 1] if '-o' in a else a[a.index('--output') + 1]
if os.environ.get('FAKE_CLI_FAIL') == '/'.join(key):
    print('Error: simulated failure'); sys.exit(3)
if key == ('pcb', 'export', 'ipc2581'):
    shutil.copy(os.path.join(DATA, 'ipc', 'testcase3.xml'), out)
elif key == ('pcb', 'export', 'step'):
    shutil.copy(os.path.join(DATA, 'step', 'testcase3_partial.step'), out)
    if os.environ.get('FAKE_STEP_WARN'):
        # KiCad behaviour: file written, VRML warning, non-zero exit, console code page output
        sys.stdout.flush()
        sys.stdout.buffer.write(("Cannot use VRML models when exporting to non-mesh formats.\nSTEP file '" + out + "' created.\n").encode('cp1254'))
        sys.exit(1)
elif key == ('sch', 'export', 'bom'):
    labels = a[a.index('--labels') + 1].split(',')
    rows = list(csv.DictReader(open(os.path.join(DATA, 'ipc', 'BOM.csv'), encoding='utf-8-sig')))
    with open(out, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(labels)
        for r in rows:
            refs = ','.join(x.strip() for x in r['Designator'].split(','))
            m = {'Reference': refs, 'Value': r['Comment'], 'Footprint': 'Lib:' + r['Comment'], 'Qty': r['Quantity'],
                 'Description': r['Description'], 'Manufacturer': 'Üretici A.Ş.', 'MPN': r['Manufacturer Part Number']}
            w.writerow([m.get(l, '') for l in labels])
else:
    print('unknown command', a); sys.exit(2)
print('Done.')
