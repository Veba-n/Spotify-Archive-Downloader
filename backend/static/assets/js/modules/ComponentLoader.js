export const ComponentLoader = {
    async load(id, url) {
        const container = document.getElementById(id);
        if (!container) return;
        const res = await fetch(url);
        const html = await res.text();
        container.innerHTML = html;
        return container;
    }
};
