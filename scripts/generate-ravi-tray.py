"""Reproducible native tray RGBA assets, stdlib only; original Ravi vector geometry."""
from pathlib import Path
polygons = [('#2a356b',[(3,22),(8,8),(12,2),(14,8),(23,8),(29,17),(28,28),(5,29)]),
('#353f73',[(8,8),(12,2),(14,8),(23,8),(18,16)]),
('#f5c297',[(7,17),(13,14),(16,19),(21,14),(27,17),(25,24),(9,25)]),
('#e16638',[(14,21),(17,19),(20,22),(17,25)])]
circles=[('#1f224e',11,19,2.3),('#1f224e',23,19,2.3),('#ffffff',10.5,18.4,.8),('#ffffff',22.5,18.4,.8)]
def inside(x,y,points):
    hit=False
    for (a,b),(c,d) in zip(points,points[1:]+points[:1]):
        if (b>y)!=(d>y) and x<(c-a)*(y-b)/(d-b)+a: hit=not hit
    return hit
root=Path('src-tauri/icons');root.mkdir(exist_ok=True)
svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
for color,points in polygons: svg+=f'<polygon fill="{color}" points="'+ ' '.join(f'{x},{y}' for x,y in points)+'"/>'
for color,x,y,r in circles: svg+=f'<circle fill="{color}" cx="{x}" cy="{y}" r="{r}"/>'
(root/'ravi-tray.svg').write_text(svg+'</svg>\n')
for template,sizes in [(False,[16,32,48,64]),(True,[22,44])]:
    for size in sizes:
        pixels=bytearray()
        for y in range(size):
            for x in range(size):
                samples=[]
                for dy in [.25,.75]:
                    for dx in [.25,.75]:
                        px,py=(x+dx)*32/size,(y+dy)*32/size; color=None
                        for col,points in polygons:
                            if inside(px,py,points):color=col
                        for col,cx,cy,r in circles:
                            if (px-cx)**2+(py-cy)**2<=r*r: color=col
                        if template:
                            eye=any((px-cx)**2+(py-cy)**2<=r*r for col,cx,cy,r in circles if col=='#1f224e')
                            samples.append((0,0,0,255 if color and not eye else 0))
                        else:samples.append(tuple(int(color[i:i+2],16) for i in (1,3,5))+(255,) if color else (0,0,0,0))
                pixels.extend(round(sum(s[i] for s in samples)/4) for i in range(4))
        (root/f'ravi-tray-{"template-" if template else ""}{size}.rgba').write_bytes(pixels)
