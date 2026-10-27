"""Ejecuta localmente las celdas de código de un notebook generado, simulando Colab.
Uso: python3 -I run_notebook.py NOTEBOOK.ipynb   (requiere COLABMGR_BASE en el entorno)
Esto prueba el runtime de forma LOCAL; NO sustituye una prueba real en Google Colab."""
import json
import sys

nb = json.load(open(sys.argv[1], encoding='utf-8'))
ns = {'__name__': '__main__'}
for cell in nb['cells']:
    if cell['cell_type'] == 'code':
        exec(compile(''.join(cell['source']), f'<celda {cell.get("id")}>', 'exec'), ns)
