import { createContext, useContext } from 'react';

// Shared app state: meta, agents, keys, admin token, toast. Provided by App.jsx.
export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);
