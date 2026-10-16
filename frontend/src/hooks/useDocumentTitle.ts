import { useEffect } from "react";

const SITE = "Gauss Aurora";

/** Names the browser tab after the page: "Heliophysics · Gauss Aurora". Omit for the site name alone. */
export function useDocumentTitle(page?: string): void {
  useEffect(() => {
    document.title = page ? `${page} · ${SITE}` : `${SITE} · Lightbound`;
  }, [page]);
}
