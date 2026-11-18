import express from 'express';
import { authenticateUser, requireRoles } from '../middleware/auth.js';
import { configuredOffice } from '../services/officeConfiguration.js';
import { matchOfficeIP, peerAddress } from '../services/officeNetworks.js';
import { listOffices, saveOffice, deleteOffice, officeAuditLog } from '../controllers/superAdminOfficesController.js';
import { requestOptions, previewRequest, createPersonalRequest, cancelPersonalRequest } from '../controllers/superAdminRequestsController.js';
import { pendingApprovals, reviewRequest, monthlyAttendance, exportMonthlyAttendance, getHRRequests, getAllRequests, editAttendance } from '../controllers/superAdminOperationsController.js';
const router = express.Router();
router.use(authenticateUser, requireRoles('SUPER_ADMIN'));

// This installation has one organization. Only return configured office data.
router.get('/dashboard', async (req, res, next) => {
  try {
    const office = await configuredOffice(req.user);
    const connectionIP = peerAddress(req);
    res.json({
      success: true,
      data: {
        office: office || null,
        demo: false,
        network: {
          ip: connectionIP,
          matched: !!office && matchOfficeIP(connectionIP, office.office_ips || [])
        },
        personalAttendanceEnabled: false,
        notesEnabled: false,
        approvalsEnabled: true
      }
    });
  } catch (error) {
    next(error);
  }
});
router.get('/requests/options', requestOptions);
router.post('/requests/preview', previewRequest);
router.post('/requests', createPersonalRequest);
router.patch('/requests/:id/cancel', cancelPersonalRequest);
router.get('/approvals', pendingApprovals);
router.get('/hr-requests', getHRRequests);
router.get('/requests/all', getAllRequests);
router.post('/attendance/edit', editAttendance);
router.put('/attendance/edit', editAttendance);
router.patch('/requests/:id/decision', reviewRequest);
router.get('/reports/attendance', monthlyAttendance);
router.get('/reports/attendance/export', exportMonthlyAttendance);
router.get('/offices', listOffices);
router.post('/offices', saveOffice);
router.put('/offices/:id', saveOffice);
router.delete('/offices/:id', deleteOffice);
router.get('/admin/audit-log', officeAuditLog);
export default router;
