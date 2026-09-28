/** 網址參數：?debug=1&level=3，也接受 #debug=1&level=3（有些預覽環境會去掉 ?）。 */
export const params = new URLSearchParams(location.search || location.hash.slice(1));
