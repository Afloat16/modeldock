#!/usr/bin/env node
/** Original, deterministic demo geometry. No network, assets or DCC required. */
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

const target = fileURLToPath(new URL('../fixtures/', import.meta.url));
await mkdir(target, { recursive: true });
let seed = 0x4d4f444c;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const vertices = [], faces = [];
const add = p => { vertices.push(p); return vertices.length - 1; };
function surface(nu, nv, fn, reverse = false) {
  const start = vertices.length;
  for (let u = 0; u <= nu; u++) for (let v = 0; v <= nv; v++) add(fn(u / nu, v / nv));
  for (let u = 0; u < nu; u++) for (let v = 0; v < nv; v++) {
    const a = start + u * (nv + 1) + v, b = a + nv + 1, c = b + 1, d = a + 1;
    faces.push(reverse ? [a, c, b] : [a, b, c], reverse ? [a, d, c] : [a, c, d]);
  }
}
function box(x, y, z, sx, sy, sz) {
  const base = vertices.length;
  for (const [a,b,c] of [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]) add([x+a*sx/2,y+b*sy/2,z+c*sz/2]);
  for (const f of [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]]) faces.push(f.map(i => i + base));
}
const inner=1.80, outer=2.42, spring=1.12, depth=1.42;
for (const radius of [inner,outer]) surface(112,20,(u,v)=>[radius*Math.cos(u*Math.PI),spring+radius*Math.sin(u*Math.PI),(v-.5)*depth],radius===inner);
for(const z of [-depth/2,depth/2])surface(112,7,(u,v)=>{const r=inner+(outer-inner)*v;return[r*Math.cos(u*Math.PI),spring+r*Math.sin(u*Math.PI),z];},z>0);
box(-(inner+outer)/2,spring/2,0,outer-inner,spring,depth);
box((inner+outer)/2,spring/2,0,outer-inner,spring,depth);
box(0,-.16,0,5.55,.32,2.35);
// Two small rectangular steps make scale/orientation legible in a point cloud.
box(0,-.28,1.0,3.0,.18,1.55);
box(0,-.36,1.55,3.65,.12,.70);
const palette = [new THREE.Color('#4c68db'),new THREE.Color('#27b8cb'),new THREE.Color('#90e0bb'),new THREE.Color('#f3c66d')];
function rgb(point) {
  const phase=Math.max(0,Math.min(0.99999,(point[0]+2.6)/5.2*.55+(point[1]+.5)/4.2*.45));
  const index=Math.floor(phase*3),c=palette[index].clone().lerp(palette[index+1],phase*3-index).convertLinearToSRGB();
  return [c.r,c.g,c.b].map(v=>Math.round(Math.max(0,Math.min(1,v))*255));
}
function plyBinary(points, triangles) {
  const header=Buffer.from(`ply\nformat binary_little_endian 1.0\ncomment ModelDock original synthetic architectural demo; MIT\nelement vertex ${points.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\n${triangles?`element face ${triangles.length}\nproperty list uchar int vertex_indices\n`:''}end_header\n`);
  const data=Buffer.alloc(points.length*15+(triangles?.length??0)*13);
  let at=0;
  for(const point of points){for(const value of point){data.writeFloatLE(value,at);at+=4;}for(const value of rgb(point))data[at++]=value;}
  for(const triangle of triangles??[]){data[at++]=3;for(const i of triangle){data.writeInt32LE(i,at);at+=4;}}
  return Buffer.concat([header,data]);
}
const cumulative=[];let total=0;
for(const f of faces){const a=new THREE.Vector3(...vertices[f[0]]),b=new THREE.Vector3(...vertices[f[1]]),c=new THREE.Vector3(...vertices[f[2]]);total+=b.sub(a).cross(c.sub(a)).length()/2;cumulative.push(total);}
const cloud=[];
for(let i=0;i<48_000;i++){
  const draw=random()*total;let lo=0,hi=cumulative.length-1;
  while(lo<hi){const middle=(lo+hi)>>>1;if(cumulative[middle]<draw)lo=middle+1;else hi=middle;}
  const [a,b,c]=faces[lo].map(index=>vertices[index]);const u=Math.sqrt(random()),v=random();
  cloud.push(a.map((value,k)=>value*(1-u)+b[k]*u*(1-v)+c[k]*u*v+(random()-.5)*.007));
}
await writeFile(path.join(target,'demo-arch-cloud.ply'),plyBinary(cloud));
await writeFile(path.join(target,'demo-arch-mesh.ply'),plyBinary(vertices,faces));

// A self-created checker PNG. CRC and PNG encoding stay in this tiny generator.
function crc32(bytes){let c=0xffffffff;for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const tag=Buffer.from(type),result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);tag.copy(result,4);data.copy(result,8);result.writeUInt32BE(crc32(Buffer.concat([tag,data])),data.length+8);return result;}
const pngHeader=Buffer.alloc(13);pngHeader.writeUInt32BE(16,0);pngHeader.writeUInt32BE(16,4);pngHeader[8]=8;pngHeader[9]=6;
const scanlines=Buffer.alloc(16*(1+16*4));
for(let y=0;y<16;y++)for(let x=0;x<16;x++){const color=((x>>2)+(y>>2))%2?[236,178,89,255]:[46,148,162,255];Buffer.from(color).copy(scanlines,y*65+1+x*4);}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',pngHeader),chunk('IDAT',deflateSync(scanlines)),chunk('IEND',Buffer.alloc(0))]);
const boxGeometry=new THREE.BoxGeometry(2,2,2);
const position=Buffer.from(boxGeometry.attributes.position.array.buffer),normal=Buffer.from(boxGeometry.attributes.normal.array.buffer),uv=Buffer.from(boxGeometry.attributes.uv.array.buffer),indices=Buffer.from(boxGeometry.index.array.buffer);
const bufferViews=[],binaryParts=[];let byteLength=0;
function addView(data,target){while(byteLength%4){binaryParts.push(Buffer.from([0]));byteLength++;}const view={buffer:0,byteOffset:byteLength,byteLength:data.length,...(target?{target}:{})};bufferViews.push(view);binaryParts.push(data);byteLength+=data.length;return bufferViews.length-1;}
const p=addView(position,34962),n=addView(normal,34962),uvIndex=addView(uv,34962),idx=addView(indices,34963),image=addView(png);
const scene={asset:{version:'2.0',generator:'ModelDock original demo generator'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'Original checker cube',mesh:0,rotation:[0,Math.sin(Math.PI/12),0,Math.cos(Math.PI/12)]}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2},indices:3,material:0}]}],accessors:[{bufferView:p,componentType:5126,count:24,type:'VEC3',min:[-1,-1,-1],max:[1,1,1]},{bufferView:n,componentType:5126,count:24,type:'VEC3'},{bufferView:uvIndex,componentType:5126,count:24,type:'VEC2'},{bufferView:idx,componentType:5123,count:36,type:'SCALAR'}],materials:[{name:'Teal and amber checks',pbrMetallicRoughness:{baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:.65}}],textures:[{source:0,sampler:0}],samplers:[{magFilter:9728,minFilter:9728,wrapS:10497,wrapT:10497}],images:[{bufferView:image,mimeType:'image/png'}],bufferViews,buffers:[{byteLength}]};
let binary=Buffer.concat(binaryParts);
const embedded=structuredClone(scene);embedded.buffers[0].uri='data:application/octet-stream;base64,'+binary.toString('base64');
await writeFile(path.join(target,'textured-cube.gltf'),JSON.stringify(embedded,null,2)+'\n');
const json=Buffer.from(JSON.stringify(scene)),jsonPad=(4-json.length%4)%4,binPad=(4-binary.length%4)%4;
const jsonChunk=Buffer.concat([json,Buffer.alloc(jsonPad,32)]);binary=Buffer.concat([binary,Buffer.alloc(binPad)]);
const glbHeader=Buffer.alloc(12);glbHeader.writeUInt32LE(0x46546c67);glbHeader.writeUInt32LE(2,4);glbHeader.writeUInt32LE(12+8+jsonChunk.length+8+binary.length,8);
const jsonChunkHeader=Buffer.alloc(8);jsonChunkHeader.writeUInt32LE(jsonChunk.length);jsonChunkHeader.writeUInt32LE(0x4e4f534a,4);
const binChunkHeader=Buffer.alloc(8);binChunkHeader.writeUInt32LE(binary.length);binChunkHeader.writeUInt32LE(0x004e4942,4);
await writeFile(path.join(target,'textured-cube.glb'),Buffer.concat([glbHeader,jsonChunkHeader,jsonChunk,binChunkHeader,binary]));
boxGeometry.dispose();
console.log(`Generated original demos: ${cloud.length.toLocaleString()} points, ${vertices.length.toLocaleString()} mesh vertices, ${faces.length.toLocaleString()} triangles, embedded checker GLB/glTF.`);
