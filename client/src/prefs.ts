// Preferências locais do painel (por navegador): nome exibido e cor da marca.
export type Brand = 'red' | 'blue';

const NAME_KEY = 'lawhub.userName';
const BRAND_KEY = 'lawhub.brand';

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export const getUserName = () => read(NAME_KEY) || '';
export const setUserName = (v: string) => write(NAME_KEY, v.trim());

export const getBrand = (): Brand => (read(BRAND_KEY) === 'blue' ? 'blue' : 'red');
export function applyBrand(b: Brand = getBrand()) {
  if (b === 'blue') document.documentElement.dataset.brand = 'blue';
  else delete document.documentElement.dataset.brand;
}
export function setBrand(b: Brand) {
  write(BRAND_KEY, b);
  applyBrand(b);
}
