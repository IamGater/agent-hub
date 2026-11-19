import { useEffect, useState } from 'react';

function parse() {
  const [, page = '', arg = ''] = location.hash.split('/');
  return { page, arg: decodeURIComponent(arg) };
}

export function navigate(path) {
  location.hash = path;
}

export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
