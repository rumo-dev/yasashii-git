const menu=document.querySelector('.menu-toggle');
const sidebar=document.querySelector('.sidebar');
if(menu&&sidebar){
  menu.addEventListener('click',()=>{
    const open=sidebar.classList.toggle('open');
    menu.setAttribute('aria-expanded',String(open));
  });
  document.querySelectorAll('.nav-link').forEach(link=>link.addEventListener('click',()=>{
    sidebar.classList.remove('open');
    menu.setAttribute('aria-expanded','false');
  }));
}
const sections=[...document.querySelectorAll('main section[id],main#top')];
const links=[...document.querySelectorAll('.nav-link')];
if('IntersectionObserver' in window){
  const observer=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(entry.isIntersecting){
        const id=entry.target.id||'top';
        links.forEach(link=>link.classList.toggle('active',link.getAttribute('href')==='#'+id));
      }
    }
  },{rootMargin:'-20% 0px -70% 0px'});
  sections.forEach(section=>observer.observe(section));
}
const search=document.querySelector('#guide-search');
const searchStatus=document.querySelector('#search-status');
const chapters=[...document.querySelectorAll('main .chapter[id]')];
const normalize=value=>value.normalize('NFKC').toLocaleLowerCase('ja').trim();
function filterGuide(){
  if(!search)return;
  const query=normalize(search.value);
  let shown=0;
  chapters.forEach(chapter=>{
    const match=!query||normalize(chapter.textContent).includes(query);
    chapter.hidden=!match;
    shown+=Number(match);
    const link=links.find(item=>item.hash==='#'+chapter.id);
    if(link)link.hidden=!match;
  });
  if(searchStatus)searchStatus.textContent=query?`${shown}件の章が見つかりました${shown===0?'。検索語を変えてください':''}`:'';
}
search?.addEventListener('input',filterGuide);
search?.addEventListener('keydown',event=>{
  if(event.key==='Escape'){search.value='';filterGuide();search.blur();}
});
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){
    event.preventDefault();search?.focus();
  }
});

const simulator=document.querySelector('[data-git-practice]');
if(simulator){
  let stage=0;
  const status=document.querySelector('#practice-status');
  const log=document.querySelector('#practice-log');
  const messages=[
    ['作業前','ファイルはまだ変更されていません。'],
    ['変更中','ファイルに変更があります。まだ記録には含まれていません。'],
    ['記録済み','変更は自分のPCに記録されました。GitHubにはまだ送られていません。'],
    ['共有済み','記録がGitHubに共有されました。チームの人も確認できます。'],
  ];
  const addLog=message=>{
    const item=document.createElement('li');
    item.textContent=message;
    log.replaceChildren(item);
  };
  const render=()=>{
    const [title,description]=messages[stage];
    status.querySelector('strong').textContent=title;
    status.querySelector('small').textContent=description;
    simulator.querySelector('[data-lane="file"]').classList.toggle('is-active',stage>=1);
    simulator.querySelector('[data-lane="record"]').classList.toggle('is-active',stage>=2);
    simulator.querySelector('[data-lane="remote"]').classList.toggle('is-active',stage>=3);
    simulator.querySelector('[data-stage="change"]').disabled=stage!==0;
    simulator.querySelector('[data-stage="commit"]').disabled=stage!==1;
    simulator.querySelector('[data-stage="push"]').disabled=stage!==2;
  };
  simulator.addEventListener('click',event=>{
    const button=event.target.closest('button[data-stage]');
    if(!button)return;
    if(button.dataset.stage==='reset'){
      stage=0;
      addLog('まだ何もしていません。最初のボタンを押してください。');
    }else if(stage<3){
      stage+=1;
      addLog(messages[stage][0]+'：'+messages[stage][1]);
    }
    render();
  });
  render();
}

document.querySelectorAll('[data-quiz]').forEach(question=>{
  const feedback=question.querySelector('.quiz-feedback');
  question.querySelectorAll('.quiz-options button').forEach(button=>button.addEventListener('click',()=>{
    const correct=button.dataset.correct==='true';
    question.querySelectorAll('.quiz-options button').forEach(option=>{
      option.classList.remove('is-correct','is-wrong');
      option.disabled=true;
    });
    button.classList.add(correct?'is-correct':'is-wrong');
    feedback.textContent=correct?'正解です。よくできました！':'今回は違います。正しい答えを表示しました。';
    if(!correct)question.querySelector('.quiz-options [data-correct="true"]')?.classList.add('is-correct');
  }));
});

