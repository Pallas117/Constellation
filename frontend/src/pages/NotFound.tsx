import { Link, useLocation } from "react-router-dom";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

const NotFound = () => {
  useDocumentTitle("Page not found");
  const location = useLocation();

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="hud-panel w-full max-w-md p-8">
        <p className="brand-label">00_NOT_FOUND · 404</p>
        <h1 className="mt-3 text-2xl font-semibold">There's nothing at this address.</h1>
        <p className="mt-2 break-words text-sm text-muted-foreground">
          <code className="font-mono text-foreground">{location.pathname}</code> isn't a page on Gauss Aurora.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Go to the live landing page
        </Link>
      </div>
    </main>
  );
};

export default NotFound;
