import { createBrowserRouter, Navigate } from 'react-router-dom'
import { App } from '../App'
import { HistoryPage } from '../pages/HistoryPage'
import { ReconciliationPage } from '../pages/ReconciliationPage'
import { RecordsPage } from '../pages/RecordsPage'
import { RulesPage } from '../pages/RulesPage'
import { ValidationPage } from '../pages/ValidationPage'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate replace to="/validation" /> },
      { path: 'validation', element: <ValidationPage /> },
      { path: 'records', element: <RecordsPage /> },
      { path: 'reconciliation', element: <ReconciliationPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'rules', element: <RulesPage /> },
    ],
  },
])
