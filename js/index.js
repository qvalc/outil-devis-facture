
const tabs = document.querySelectorAll('.help-tab');
const pages = document.querySelectorAll('.help-page');
const search = document.getElementById('helpSearch');

tabs.forEach(tab => {
    tab.addEventListener('click', () => {

        tabs.forEach(t => t.classList.remove('active'));
        pages.forEach(p => p.classList.remove('active'));

        tab.classList.add('active');

        const page = document.getElementById(tab.dataset.tab);

        if(page){
            page.classList.add('active');
        }
    });
});

search.addEventListener('input', () => {

    const value = search.value.toLowerCase();

    document.querySelectorAll('.help-block').forEach(block => {

        const text = block.innerText.toLowerCase();

        if(text.includes(value)){
            block.classList.remove('search-hidden');
        }else{
            block.classList.add('search-hidden');
        }
    });
});
