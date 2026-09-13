import { transactionCode } from "./phone-transaction-qr";
/** Review state is bound to the exact pasted code. Never stores transaction data. */
export type Review = {hex:string;txid:string;outputs:{index:number;addresses:string[];rvn:string;assetKnown:boolean;asset:{name:string;quantity:string}|null}[];fee:string|null};
type Invoke = <T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
export function wirePhoneTransaction(invoke:Invoke,t:(s:string)=>string) {
  const input = document.getElementById('phone-tx-code') as HTMLTextAreaElement;
  const check = document.getElementById('phone-tx-check') as HTMLButtonElement;
  const send = document.getElementById('phone-tx-send') as HTMLButtonElement;
  const cancel = document.getElementById('phone-tx-cancel') as HTMLButtonElement;
  const preview = document.getElementById('phone-tx-preview')!;
  const status = document.getElementById('phone-tx-status')!;
  let epoch=0, reviewed:{code:string;value:Review}|null=null, sending=false;
  function invalidate() { epoch++; reviewed=null; preview.replaceChildren(); send.hidden=true; status.textContent=''; }
  input.addEventListener('input',invalidate);
  cancel.addEventListener('click',()=>{ if(sending)return; input.value='';invalidate();input.focus(); });
  function line(label:string,value:string) {
    const p=document.createElement('p'), b=document.createElement('b'), span=document.createElement('span');
    b.textContent=t(label)+': ';span.textContent=value;span.setAttribute('translate','no');p.append(b,span);preview.append(p);
  }
  check.addEventListener('click',async()=>{
    if(sending)return;
    invalidate();const ticket=epoch, code=input.value;
    if(code.length>600000 || !code.trim()) {status.textContent=t('거래 코드의 형식·버전·길이를 확인하세요. 폰에서 서명한 거래 코드를 다시 복사하세요.');return;}
    check.disabled=true;status.textContent=t('거래 내용을 확인하는 중입니다. 아직 보내지 않았습니다.');
    try {
      const canonical=await transactionCode(code);
      if(ticket!==epoch)return;
      const value=await invoke<Review>('phone_transaction_review',{code:canonical});
      if(ticket!==epoch)return;
      reviewed={code,value};
      line('거래 ID',value.txid);
      line('출력 안내',t('거스름돈을 포함한 모든 출력입니다. 받는 사람과 거스름돈은 자동으로 구분하지 못합니다.'));
      for(const output of value.outputs) {
        const heading=document.createElement('h4');heading.textContent=t('출력')+' '+(output.index+1);preview.append(heading);
        line('받는 주소',output.addresses.length?output.addresses.join(', '):t('확인 못 함'));
        line('RVN 금액',output.rvn+' RVN');
        line('자산',output.asset ? output.asset.name+' · '+output.asset.quantity : t(output.assetKnown?'없음':'확인 못 함'));
      }
      line('수수료',value.fee===null?t('확인 못 함'):value.fee+' RVN');
      status.textContent=t('아직 보내지 않았습니다. 폰의 내용과 대조한 뒤 확인하고 보내세요.');
      send.hidden=false;send.disabled=false;
    } catch(error) {if(ticket===epoch)status.textContent=t(error instanceof Error?error.message:String(error));}
    finally {check.disabled=false;}
  });
  send.addEventListener('click',async()=>{
    if(sending || !reviewed || input.value!==reviewed.code)return;
    const chosen=reviewed; sending=true;send.disabled=true;check.disabled=true;input.disabled=true;cancel.disabled=true;
    status.textContent=t('네트워크에 보내는 중입니다.');
    try {
      const result=await invoke<{txid:string}>('phone_transaction_send',{code:`ravenvault://transaction?v=1&hex=${chosen.value.hex}`,expectedTxid:chosen.value.txid,confirmed:true});
      status.textContent=t(result.txid===chosen.value.txid?'노드가 거래를 받았습니다. 블록 확정은 아직 확인 못 함.':'전파 결과를 확인 못 했습니다. 다시 보내기 전에 거래 ID로 확인하세요.');
    } catch(error) {status.textContent=t(error instanceof Error?error.message:String(error));}
    finally {reviewed=null;send.hidden=true;sending=false;check.disabled=false;input.disabled=false;cancel.disabled=false;}
  });
}
