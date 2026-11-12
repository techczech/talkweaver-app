// Authored synthetic ONNX Constant graph, not trained weights. Recreated locally so no model
// binary is uploaded. Logits represent blank, A, separator, A, blank (20 ms frames).
const vint=n=>{const b=[];do{b.push((n&127)|(n>127?128:0));n=Math.floor(n/128)}while(n);return Buffer.from(b)}
const num=(field,n)=>Buffer.concat([vint(field*8),vint(n)])
const bytes=(field,b)=>{b=typeof b==='string'?Buffer.from(b):b;return Buffer.concat([vint(field*8+2),vint(b.length),b])}
const message=(...parts)=>Buffer.concat(parts)
function value(name,dims){
 const shape=message(...dims.map(d=>bytes(1,typeof d==='number'?num(1,d):bytes(2,d))))
 return message(bytes(1,name),bytes(2,bytes(1,message(num(1,1),bytes(2,shape)))))
}
export function tinyOnnxFixture(){
 const logits=Buffer.alloc(15*4);[0,1,2,1,0].forEach((label,t)=>{for(let c=0;c<3;c++)logits.writeFloatLE(c===label?8:-8,(t*3+c)*4)})
 const tensor=message(num(1,1),num(1,5),num(1,3),num(2,1),bytes(9,logits))
 const attribute=message(bytes(1,'value'),bytes(5,tensor),num(20,4))
 const node=message(bytes(2,'logits'),bytes(4,'Constant'),bytes(5,attribute))
 const graph=message(bytes(1,node),bytes(2,'synthetic-alignment-fixture'),bytes(11,value('input_values',[1,'samples'])),bytes(12,value('logits',[1,5,3])))
 return message(num(1,8),bytes(2,'TalkWeaver synthetic fixture'),bytes(7,graph),bytes(8,num(2,13)))
}
