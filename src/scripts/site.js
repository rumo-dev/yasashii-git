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

