"""Regenerate ModelDock's original fixtures. Mesh/point files need Python only.
CAD fixtures additionally require cadquery/OCP. All output is MIT-licensed.
"""
from pathlib import Path
import colorsys
import math
import struct

ROOT = Path(__file__).resolve().parent

def generate_meshes():
    nu, nv = 64, 32
    vertices, faces = [], []
    for i in range(nu):
        for j in range(nv):
            u, v = i * 2 * math.pi / nu, j * 2 * math.pi / nv
            radius = 2.5 + .85 * math.cos(v)
            x, y, z = radius * math.cos(u), radius * math.sin(u), .85 * math.sin(v)
            rgb = tuple(round(c * 255) for c in colorsys.hsv_to_rgb(i / nu, .65, .95))
            vertices.append((x, y, z, *rgb))
            a = i * nv + j
            b = ((i + 1) % nu) * nv + j
            c = ((i + 1) % nu) * nv + (j + 1) % nv
            d = i * nv + (j + 1) % nv
            faces.extend([(a, b, c), (a, c, d)])
    header = f'ply\nformat ascii 1.0\ncomment Original ModelDock MIT fixture\nelement vertex {len(vertices)}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\n'
    body = '\n'.join(' '.join(f'{v:.6f}' if isinstance(v, float) else str(v) for v in vertex) for vertex in vertices) + '\n'
    (ROOT / 'colored-points.ply').write_text(header + 'end_header\n' + body)
    (ROOT / 'colored-mesh.ply').write_text(header + f'element face {len(faces)}\nproperty list uchar int vertex_indices\nend_header\n' + body + '\n'.join('3 ' + ' '.join(map(str, f)) for f in faces) + '\n')
    for encoding, endian in [('little', '<'), ('big', '>')]:
        binary_header = f'ply\nformat binary_{encoding}_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n'
        data = b''.join(struct.pack(endian + 'fffBBB', *p) for p in [(0.,0.,0.,255,0,0),(2.,0.,0.,0,255,0),(0.,3.,0.,0,0,255)])
        (ROOT / f'triangle-{encoding}.ply').write_bytes(binary_header.encode() + data + struct.pack(endian + 'Biii', 3,0,1,2))
    ascii_stl = 'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2 0 0\nvertex 0 3 0\nendloop\nendfacet\nendsolid triangle\n'
    (ROOT / 'triangle-ascii.stl').write_text(ascii_stl)
    binary_stl = b'solid binary triangle'.ljust(80,b'\0') + struct.pack('<I12fH',1,0,0,1,0,0,0,2,0,0,0,3,0,0)
    (ROOT / 'triangle-binary.stl').write_bytes(binary_stl)
    (ROOT / 'pyramid.obj').write_text('# Original MIT fixture\no Pyramid\nv -1 -1 0\nv 1 -1 0\nv 1 1 0\nv -1 1 0\nv 0 0 2\nf 1 4 3 2\nf 1 2 5\nf 2 3 5\nf 3 4 5\nf 4 1 5\n')
    (ROOT / 'triangle.off').write_text('OFF\n3 1 0\n0 0 0\n2 0 0\n0 3 0\n3 0 1 2\n')
    (ROOT / 'points.xyz').write_text('# XYZ RGB\n0 0 0 255 0 0\n2 0 0 0 255 0\n0 3 0 0 0 255\n')
    (ROOT / 'points.pcd').write_text('# .PCD v0.7\nVERSION 0.7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH 3\nHEIGHT 1\nPOINTS 3\nDATA ascii\n0 0 0 16711680\n2 0 0 65280\n0 3 0 255\n')

def generate_cad():
    try:
        import cadquery as cq
        from OCP.IGESControl import IGESControl_Writer, IGESControl_Controller
        from OCP.BRepTools import BRepTools
    except ImportError:
        print('Skipping CAD regeneration: install cadquery to generate CAD fixtures.')
        return
    shape = cq.Workplane('XY').box(20, 15, 10).val()
    cq.exporters.export(shape, str(ROOT / 'cube.step'))
    BRepTools.Write_s(shape.wrapped, str(ROOT / 'cube.brep'))
    IGESControl_Controller.Init_s()
    writer = IGESControl_Writer('MM', 0)
    writer.AddShape(shape.wrapped)
    writer.ComputeModel()
    assert writer.Write(str(ROOT / 'cube.iges'))
    bracket = cq.Workplane('XY').box(64,42,10).faces('>Z').workplane().pushPoints([(-22,-12),(-22,12),(22,-12),(22,12)]).hole(6).faces('>Z').workplane().circle(14).extrude(18).faces('>Z').workplane().hole(18)
    cq.exporters.export(bracket, str(ROOT / 'mounting-bracket.step'))

if __name__ == '__main__':
    generate_meshes()
    generate_cad()
