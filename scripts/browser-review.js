// Framework-independent development annotation. Loaded by the generated
// bookmarklet; no application dependencies or source edits.
(() => {
  const source = document.currentScript;
  const endpoint = source?.dataset.endpoint;
  if (!endpoint || document.getElementById('yano-review-overlay')) return;
  const host = document.createElement('div'); host.id = 'yano-review-overlay';
  const shadow = host.attachShadow({mode:'open'});
  shadow.innerHTML = `<style>:host{all:initial;position:fixed;z-index:2147483647;bottom:18px;right:18px;font:14px system-ui}button,input,textarea{font:inherit}button{cursor:pointer;padding:8px}dialog{max-width:min(480px,90vw);border:1px solid #334554;border-radius:8px;background:#101820;color:#edf3f7;padding:20px}textarea{box-sizing:border-box;width:100%;min-height:100px;margin:12px 0}label{display:block;margin:8px 0}small{display:block;overflow-wrap:anywhere;color:#aec0ce}</style><button id="pick">Annota elemento</button><button id="exit" aria-label="Chiudi annotazioni">×</button><dialog><form method="dialog"><strong>Feedback sull’elemento</strong><small id="target"></small><label>Descrizione<textarea id="comment" required></textarea></label><label>Screenshot facoltativo<input id="image" type="file" accept="image/png,image/jpeg,image/webp"></label><small id="status" role="status"></small><button id="send" type="button">Invia a Yano</button><button value="cancel">Annulla</button></form></dialog>`;
  document.documentElement.append(host);
  let annotation;
  const dialog=shadow.querySelector('dialog'), status=shadow.querySelector('#status');
  function selector(el) {
    if(el.id) return '#'+CSS.escape(el.id);
    const parts=[];for(let node=el;node?.nodeType===1&&parts.length<8;node=node.parentElement){let part=node.localName;const siblings=node.parentElement?[...node.parentElement.children].filter(s=>s.localName===part):[];if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';parts.unshift(part);}return parts.join(' > ');
  }
  function pick(event) {
    if(event.composedPath().includes(host))return;
    event.preventDefault();event.stopImmediatePropagation();document.removeEventListener('click',pick,true);
    const el=event.composedPath().find(n=>n instanceof Element), rect=el.getBoundingClientRect(), style=getComputedStyle(el);
    annotation={id:crypto.randomUUID(),element:el.localName,elementPath:selector(el),selectedText:String(getSelection()).slice(0,1000),cssClasses:String(el.className||''),browser_context:{url:location.href,viewport:{width:innerWidth,height:innerHeight},rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},styles:{color:style.color,background:style.backgroundColor,font:style.font},shadow_dom:el.getRootNode()!==document}};
    shadow.querySelector('#target').textContent=annotation.elementPath;status.textContent='';dialog.showModal();shadow.querySelector('#comment').focus();
  }
  shadow.querySelector('#pick').onclick=()=>{status.textContent='';document.addEventListener('click',pick,true);shadow.querySelector('#pick').textContent='Seleziona un elemento…';};
  shadow.querySelector('#exit').onclick=()=>{document.removeEventListener('click',pick,true);host.remove();};
  shadow.querySelector('#send').onclick=async()=>{
    const comment=shadow.querySelector('#comment').value.trim();if(!comment){status.textContent='Scrivi una descrizione.';return;}
    const button=shadow.querySelector('#send');button.disabled=true;
    try{
      const screenshots=[],file=shadow.querySelector('#image').files[0];
      if(file){if(file.size>5*1024*1024)throw Error('Screenshot massimo 5 MB');screenshots.push(await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:reader.result});reader.onerror=reject;reader.readAsDataURL(file);}));}
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({annotation:{...annotation,comment},page_url:location.href,created_by:'browser-review',screenshots,browser_context:annotation.browser_context})});
      const result=await response.json();if(!response.ok)throw Error(result.error||'Invio fallito');status.textContent='Ricevuto: '+result.id;shadow.querySelector('#comment').value='';shadow.querySelector('#pick').textContent='Annota elemento';
    }catch(error){status.textContent=error.message+' — verifica che le API Yano siano raggiungibili e consentite dal browser.';}finally{button.disabled=false;}
  };
})();
