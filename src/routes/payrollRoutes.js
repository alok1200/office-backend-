import express from 'express';
import { authenticateUser, requireRoles } from '../middleware/auth.js';
import {
  getPayrollDashboard,
  listEmployeeSalaries,
  upsertEmployeeSalary,
  getSalaryHistory,
  upsertBankAccount,
  previewMonthlyPayroll,
  generateMonthlyPayroll,
  listPayrollPeriods,
  getPayrollPeriodDetails,
  submitPayrollPeriod,
  approvePayrollPeriod,
  rejectPayrollPeriod,
  authorizePayrollPayments,
  listSalaryPayments,
  getPaymentTransactions,
  retrySalaryPayment,
  handlePaymentWebhook,
  getProviderSettings,
  updateProviderSettings,
  listPayslips,
  downloadPayslipPdf,
  exportPayrollReport,
} from '../controllers/payrollController.js';

const router = express.Router();

// Provider webhooks (verified via HMAC signature on rawBody; no user bearer token)
router.post('/webhooks/:provider', handlePaymentWebhook);

// All remaining payroll endpoints require authenticated session
router.use(authenticateUser);

// Dashboard (role-scoped inside controller)
router.get('/dashboard', requireRoles('EMPLOYEE', 'HR_ADMIN', 'SUPER_ADMIN'), getPayrollDashboard);

// Employee salary & bank management (HR Admin + Super Admin)
router.get('/salaries', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), listEmployeeSalaries);
router.put('/salaries/:employeeId', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), upsertEmployeeSalary);
router.put('/bank-accounts/:employeeId', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), upsertBankAccount);

// Salary history (Employee sees own; HR/Super Admin see all or filtered)
router.get('/salary-history', requireRoles('EMPLOYEE', 'HR_ADMIN', 'SUPER_ADMIN'), getSalaryHistory);

// Monthly payroll calculation, generation & submission (HR Admin + Super Admin)
router.get('/periods', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), listPayrollPeriods);
router.get('/periods/preview', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), previewMonthlyPayroll);
router.post('/periods/generate', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), generateMonthlyPayroll);
router.get('/periods/:id', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), getPayrollPeriodDetails);
router.post('/periods/:id/submit', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), submitPayrollPeriod);

// Approval, rejection, payment authorization & retries (Super Admin ONLY)
router.post('/periods/:id/approve', requireRoles('SUPER_ADMIN'), approvePayrollPeriod);
router.post('/periods/:id/reject', requireRoles('SUPER_ADMIN'), rejectPayrollPeriod);
router.post('/periods/:id/authorize-payments', requireRoles('SUPER_ADMIN'), authorizePayrollPayments);
router.get('/payments', requireRoles('SUPER_ADMIN'), listSalaryPayments);
router.get('/payments/:id/transactions', requireRoles('SUPER_ADMIN'), getPaymentTransactions);
router.post('/payments/:id/retry', requireRoles('SUPER_ADMIN'), retrySalaryPayment);
router.get('/provider-settings', requireRoles('SUPER_ADMIN'), getProviderSettings);
router.put('/provider-settings', requireRoles('SUPER_ADMIN'), updateProviderSettings);

// Payslips (Employee sees/downloads own; HR/Super Admin see/download approved)
router.get('/payslips', requireRoles('EMPLOYEE', 'HR_ADMIN', 'SUPER_ADMIN'), listPayslips);
router.get('/payslips/:recordId/pdf', requireRoles('EMPLOYEE', 'HR_ADMIN', 'SUPER_ADMIN'), downloadPayslipPdf);

// Payroll reports export (Super Admin + HR Admin)
router.get('/reports/export', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), exportPayrollReport);

export default router;
