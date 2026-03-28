export default function GlobalCSS({ T }) {
  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{background:transparent!important}
    input,button,textarea,select{font-family:'Noto Sans KR',sans-serif}
    ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${T.textMut}44;border-radius:4px}
    .hide-scrollbar::-webkit-scrollbar{display:none}.hide-scrollbar{scrollbar-width:none;-ms-overflow-style:none}
    @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
    @keyframes modalIn{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
    @keyframes checkPop{0%{transform:scale(1)}50%{transform:scale(1.25)}100%{transform:scale(1)}}
    input[type="range"]{-webkit-appearance:none;height:5px;border-radius:3px;background:${T.border};outline:none}
    input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:${T.primary};cursor:pointer;box-shadow:0 1px 4px ${T.primary}66}
  `;
  return <style>{css}</style>;
}
