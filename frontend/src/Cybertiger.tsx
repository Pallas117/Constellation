import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ui/ThemeProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { stageFor } from "./lib/auth-stage";
import { loadLogin } from "./pages/load-login";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ErrorBoundary } from "./components/ErrorBoundary";

// One chunk per page: a visitor's first load evaluates only the page they opened.
const PublicDashboard = lazy(() => import("./pages/PublicDashboard"));
const OperatorDashboard = lazy(() => import("./pages/OperatorDashboard"));
const Login = lazy(loadLogin);
const MemberHub = lazy(() => import("./pages/MemberHub"));
const ProtectionDashboard = lazy(() => import("./pages/ProtectionDashboard"));
const NotFound = lazy(() => import("./pages/NotFound"));
const HeliophysicsDashboard = lazy(() => import("./pages/HeliophysicsDashboard"));
const MeshDashboard = lazy(() => import("./pages/MeshDashboard"));
const ApiKeys = lazy(() => import("./pages/ApiKeys"));
const Evidence = lazy(() => import("./pages/Evidence"));
const LogWiring = lazy(() => import("./pages/LogWiring"));
const FundingTracker = lazy(() => import("./pages/FundingTracker"));

const queryClient = new QueryClient();

/**
 * Sign-in draws over a live page (the stage) instead of replacing it: the stage
 * renders with its own location, inert behind the overlay, so the globe that
 * was running keeps running (lib/auth-stage.ts).
 */
function AppRoutes() {
  const location = useLocation();
  const stage = stageFor(location.pathname, location.state);
  // React 18's types don't know `inert`; the wrapper is always present so the
  // stage's tree is never remounted when the overlay opens or closes.
  const behind: Record<string, unknown> = stage ? { inert: "", "aria-hidden": true } : {};

  return (
    <>
      <div className="contents" {...behind}>
        <Routes location={stage ?? location}>
          <Route path="/" element={<PublicDashboard />} />
          <Route 
            path="/operator" 
            element={
              <ProtectedRoute minRole="operator">
                <OperatorDashboard />
              </ProtectedRoute>
            } 
          />
          <Route path="/member" element={<MemberHub />} />
          <Route
            path="/heliophysics"
            element={
              <ProtectedRoute minRole="user">
                <HeliophysicsDashboard />
              </ProtectedRoute>
            }
          />
          <Route 
            path="/protection" 
            element={
              <ProtectedRoute minRole="operator">
                <ProtectionDashboard />
              </ProtectedRoute>
            } 
          />
          <Route
            path="/mesh"
            element={
              <ProtectedRoute minRole="staff">
                <MeshDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/account/api"
            element={
              <ProtectedRoute minRole="user">
                <ApiKeys />
              </ProtectedRoute>
            }
          />
          <Route
            path="/operator/evidence"
            element={
              <ProtectedRoute minRole="operator">
                <Evidence />
              </ProtectedRoute>
            }
          />
          <Route
            path="/operator/funding"
            element={
              <ProtectedRoute minRole="admin">
                <FundingTracker />
              </ProtectedRoute>
            }
          />
          <Route
            path="/account/wire"
            element={
              <ProtectedRoute minRole="user">
                <LogWiring />
              </ProtectedRoute>
            }
          />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
      {stage && (
        <Suspense fallback={null}>
          <Routes>
            <Route path="/login" element={<Login />} />
          </Routes>
        </Suspense>
      )}
    </>
  );
}

const App = () => (
  <ErrorBoundary>
    <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <Suspense fallback={<div className="min-h-[100dvh] bg-background" />}>
                <AppRoutes />
              </Suspense>
            </BrowserRouter>
          </TooltipProvider>
        </QueryClientProvider>
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
