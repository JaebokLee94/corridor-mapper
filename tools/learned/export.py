"""Convert the three frozen research checkpoints to browser inference arrays only."""
import argparse, base64, hashlib, json, pickle
from pathlib import Path
import numpy as np
import torch

parser = argparse.ArgumentParser()
parser.add_argument('research_output', type=Path)
parser.add_argument('wasm', type=Path)
args = parser.parse_args()
dest = Path(__file__).resolve().parents[2] / 'drf/models'

def b64(b):
    return base64.b64encode(b).decode()

def write(name, data):
    (dest / (name + '.mjs')).write_text('export default ' + json.dumps(data, separators=(',', ':'), allow_nan=False) + ';\n')

def tensor(a):
    a = np.ascontiguousarray(a, dtype='<f4')
    return [list(a.shape), b64(a.tobytes())]

def check(path, digest):
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    return path

root = args.research_output
tree_root = root / 'wall-evidence-review/forward/multitree'
lock = json.loads((tree_root/'lock.json').read_text())
model = pickle.loads(check(tree_root/'tree.pkl', lock['fit_hash']).read_bytes())
trees = []
for (predictor,) in model._predictors:
    nodes = []
    for n in predictor.nodes:
        assert not n['is_categorical']
        nodes.append([float(n['value'])] if n['is_leaf'] else
                     [int(n['feature_idx']), float(n['num_threshold']), int(n['left']), int(n['right'])])
    trees.append(nodes)
write('gbdt', dict(base=float(model._baseline_prediction.item()), shrink=lock['shrink'], trees=trees))
arc = root / 'wall-readout-followup/arc/upper-sum1-14633'
lock = json.loads((arc/'lock.json').read_text())
state = torch.load(check(arc/'net.pt', lock['sha256']), map_location='cpu', weights_only=True)
values = {}
for key, t in state.items():
    a = t.numpy()
    if a.ndim == 4:
        a = a.transpose(2,3,1,0)
    values[key] = tensor(a)
write('arc', dict(threshold=lock['best']['cut'], weights=values))
gat_path = root/'wmf-gru-upper-20261112f/jung/3/model.pt'
ck = torch.load(check(gat_path, '36ae5d1dfc39152cfa2ca1f47287549d1530376130a5204104acf16c355abcec'), map_location='cpu', weights_only=False)
values = {}
for key, t in ck['model'].items():
    a = t.numpy()
    if key.endswith('.W'):
        a = a.transpose(1,0,2).reshape(a.shape[1],-1)
    elif key.endswith('.weight'):
        a = a.T
    values[key] = tensor(a)
write('gat', dict(mu=ck['mu'].tolist(), sd=ck['sd'].tolist(), weights=values))
write('kernels', b64(args.wasm.read_bytes()))
