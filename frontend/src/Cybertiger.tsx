import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ui/ThemeProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ErrorBoundary } from "./components/ErrorBoundary";

// One chunk per page: a visitor's first load evaluates only the page they opened.
const PublicDashboard = lazy(() => import("./pages/PublicDashboard"));
const OperatorDashboard = lazy(() => import("./pages/OperatorDashboard"));
const Login = lazy(() => import("./pages/Login"));
const MemberHub = lazy(() => import("./pages/MemberHub"));
const ProtectionDashboard = lazy(() => import("./pages/ProtectionDashboard"));
const NotFound = lazy(() => import("./pages/NotFound"));
const HeliophysicsDashboard = lazy(() => import("./pages/HeliophysicsDashboard"));
const MeshDashboard = lazy(() => import("./pages/MeshDashboard"));
const GardenGraph = lazy(() => import("./pages/GardenGraph"));
const ApiKeys = lazy(() => import("./pages/ApiKeys"));

const queryClient = new QueryClient();

const App = () => (
  <ErrorBoundary>
    <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <Suspense fallback={<div className="min-h-[100dvh] bg-background" />}>
                <Routes>
                  <Route path="/" element={<PublicDashboard />} />
                  <Route path="/login" element={<Login />} />
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
                    path="/garden"
                    element={
                      <ProtectedRoute minRole="staff">
                        <GardenGraph />
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
                  {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </BrowserRouter>
          </TooltipProvider>
        </QueryClientProvider>
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
