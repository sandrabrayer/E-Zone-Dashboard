'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {crmPost}=require('../../lib/crm/transport');
const {installCrmReadRoutes}=require('../../lib/crm/read-routes');
const express=require('express'),http=require('node:http');
test('credentials are body-only and never forwarded on a Google response redirect',async()=>{
  const saved=global.fetch,calls=[];
  global.fetch=async(url,opts)=>{calls.push({url,opts});return calls.length===1?{status:302,headers:{get:()=> 'https://script.googleusercontent.com/macros/echo?token=fixture'}}:{ok:true,status:200,json:async()=>({ok:true})};};
  try {await crmPost('https://script.google.com/macros/s/fixture/exec',{action:'getCrmLeads',secret:'fixture'});
    assert.equal(calls[0].opts.redirect,'manual');assert.equal(calls[1].opts.method,'GET');assert.equal(calls[1].opts.body,undefined);assert.equal(calls[1].opts.redirect,'error');
  } finally {global.fetch=saved;}
});
test('unexpected redirects and credential replay redirects are refused',async()=>{
  const saved=global.fetch;
  try {for(const status of [302,307,308]) {
    let calls=0;global.fetch=async()=>{calls++;return {ok:false,status,headers:{get:()=> 'https://untrusted.example/receive'}};};
    await assert.rejects(crmPost('https://script.google.com/macros/s/fixture/exec',{secret:'fixture'}));assert.equal(calls,1);
  }} finally {global.fetch=saved;}
});
test('disabled route performs authentication then refuses without any source call',async()=>{
  const app=express();let reads=0;
  installCrmReadRoutes(app,{source:'dashboard',requireSession:(req,res,next)=>req.headers.authorization?next():res.status(401).end(),authorize:()=>true,enabled:false,read:()=>{reads++;}});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try {for(const [auth,status]of [['',401],['test',503]]) {
    const actual=await new Promise((resolve,reject)=>{const r=http.get({host:'127.0.0.1',port:server.address().port,path:'/api/crm/leads',headers:{Authorization:auth}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});r.on('error',reject);});assert.equal(actual,status);
  }assert.equal(reads,0);}finally{await new Promise(r=>server.close(r));}
});
