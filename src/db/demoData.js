import { hashPassword } from '../utils/security.js';
export function buildDemoData() {
// Seed Data Objects
const departmentsData = [{
  id: 1,
  name: 'Engineering',
  code: 'ENG'
}, {
  id: 2,
  name: 'Human Resources',
  code: 'HR'
}, {
  id: 3,
  name: 'Product & Design',
  code: 'PRD'
}, {
  id: 4,
  name: 'Marketing',
  code: 'MKT'
}, {
  id: 5,
  name: 'Finance & Operations',
  code: 'FIN'
}];

// Default password credentials for demo accounts (Password: Knooviq@2026)
// Default password credentials for demo accounts (Password: Knooviq@2026)
const defaultCreds = hashPassword('Knooviq@2026');
const employeesData = [{
  id: 1,
  employee_id: 'KNV-1001',
  email: 'alex.morgan@knooviq.com',
  first_name: 'Alex',
  last_name: 'Morgan',
  role: 'EMPLOYEE',
  department_id: 1,
  department_name: 'Engineering',
  designation: 'Senior Frontend Engineer',
  phone: '+1 (555) 234-5678',
  joining_date: '2023-03-15',
  avatar_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
  password_hash: defaultCreds.hash,
  password_salt: defaultCreds.salt,
  can_record_attendance: true,
  is_active: true
}, {
  id: 2,
  employee_id: 'KNV-1002',
  email: 'sarah.jenkins@knooviq.com',
  first_name: 'Sarah',
  last_name: 'Jenkins',
  role: 'HR_ADMIN',
  department_id: 2,
  department_name: 'Human Resources',
  designation: 'HR Operations Lead',
  phone: '+1 (555) 876-5432',
  joining_date: '2022-06-01',
  avatar_url: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80',
  password_hash: defaultCreds.hash,
  password_salt: defaultCreds.salt,
  can_record_attendance: true,
  is_active: true
}, {
  id: 3,
  employee_id: 'KNV-1003',
  email: 'michael.chen@knooviq.com',
  first_name: 'Michael',
  last_name: 'Chen',
  role: 'EMPLOYEE',
  department_id: 1,
  department_name: 'Engineering',
  designation: 'Cloud Infrastructure Architect',
  phone: '+1 (555) 345-6789',
  joining_date: '2021-11-10',
  avatar_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
  password_hash: defaultCreds.hash,
  password_salt: defaultCreds.salt,
  can_record_attendance: true,
  is_active: true
}, {
  id: 4,
  employee_id: 'KNV-1004',
  email: 'priya.sharma@knooviq.com',
  first_name: 'Priya',
  last_name: 'Sharma',
  role: 'EMPLOYEE',
  department_id: 3,
  department_name: 'Product & Design',
  designation: 'Staff UX Researcher',
  phone: '+1 (555) 456-7890',
  joining_date: '2023-01-20',
  avatar_url: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=150&auto=format&fit=crop&q=80',
  password_hash: defaultCreds.hash,
  password_salt: defaultCreds.salt,
  can_record_attendance: true,
  is_active: true
}, {
  id: 5,
  employee_id: 'KNV-1005',
  email: 'david.kim@knooviq.com',
  first_name: 'David',
  last_name: 'Kim',
  role: 'EMPLOYEE',
  department_id: 4,
  department_name: 'Marketing',
  designation: 'Growth Marketing Manager',
  phone: '+1 (555) 567-8901',
  joining_date: '2024-02-01',
  avatar_url: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
  password_hash: defaultCreds.hash,
  password_salt: defaultCreds.salt,
  can_record_attendance: true,
  is_active: true
}, {
  id: 6,
  employee_id: 'KNV-9001',
  email: 'admin@knooviq.com',
  first_name: 'Elena',
  last_name: 'Rostova',
  role: 'SUPER_ADMIN',
  department_id: 5,
  department_name: 'Finance & Operations',
  designation: 'VP of Operations',
  phone: '+1 (555) 999-0001',
  joining_date: '2020-01-01',
  avatar_url: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&auto=format&fit=crop&q=80',
  password_hash: defaultCreds.hash,
  password_salt: defaultCreds.salt,
  can_record_attendance: false,
  attendance_enabled: false,
  is_active: true
}];
const holidaysData = [{
  id: 1,
  holiday_date: '2026-01-01',
  name: "New Year's Day",
  description: 'International celebration',
  holiday_type: 'PUBLIC'
}, {
  id: 2,
  holiday_date: '2026-01-26',
  name: 'Republic Day',
  description: 'National holiday',
  holiday_type: 'PUBLIC'
}, {
  id: 3,
  holiday_date: '2026-03-25',
  name: 'Spring Festival',
  description: 'Cultural festival',
  holiday_type: 'PUBLIC'
}, {
  id: 4,
  holiday_date: '2026-05-01',
  name: "International Workers' Day",
  description: 'Labour Day',
  holiday_type: 'PUBLIC'
}, {
  id: 5,
  holiday_date: '2026-08-15',
  name: 'Independence Day',
  description: 'National holiday',
  holiday_type: 'PUBLIC'
}, {
  id: 6,
  holiday_date: '2026-10-02',
  name: 'Gandhi Jayanti',
  description: 'National observance',
  holiday_type: 'PUBLIC'
}, {
  id: 7,
  holiday_date: '2026-11-26',
  name: 'Thanksgiving Holiday',
  description: 'Company autumn recess',
  holiday_type: 'COMPANY'
}, {
  id: 8,
  holiday_date: '2026-12-25',
  name: 'Christmas Day',
  description: 'Winter celebration',
  holiday_type: 'PUBLIC'
}];
// Past attendance records for November 2026
const attendancesData = [{
  id: 1,
  employee_id: 1,
  // Alex Morgan
  work_date: '2026-11-10',
  current_state: 'CHECKED_OUT',
  check_in: '2026-11-10T09:05:00.000Z',
  check_out: '2026-11-10T18:10:00.000Z',
  total_work_minutes: 485,
  total_break_minutes: 60,
  status: 'PRESENT',
  notes: 'Normal working day'
}, {
  id: 2,
  employee_id: 1,
  work_date: '2026-11-11',
  current_state: 'CHECKED_OUT',
  check_in: '2026-11-11T09:12:00.000Z',
  check_out: '2026-11-11T13:45:00.000Z',
  total_work_minutes: 243,
  total_break_minutes: 30,
  status: 'HALF_DAY',
  notes: 'Doctor appointment in afternoon'
}, {
  id: 3,
  employee_id: 1,
  work_date: '2026-11-12',
  current_state: 'CHECKED_OUT',
  check_in: '2026-11-12T08:58:00.000Z',
  check_out: '2026-11-12T17:30:00.000Z',
  total_work_minutes: 462,
  total_break_minutes: 50,
  status: 'PRESENT',
  notes: 'Completed sprint demo'
}, {
  id: 4,
  employee_id: 1,
  work_date: '2026-11-13',
  current_state: 'NOT_CHECKED_IN',
  check_in: null,
  check_out: null,
  total_work_minutes: 0,
  total_break_minutes: 0,
  status: 'LEAVE',
  notes: 'Approved sick leave'
}, {
  id: 5,
  employee_id: 1,
  work_date: '2026-11-14',
  current_state: 'NOT_CHECKED_IN',
  check_in: null,
  check_out: null,
  total_work_minutes: 0,
  total_break_minutes: 0,
  status: 'WEEKLY_OFF',
  notes: 'Saturday weekly off'
}, {
  id: 6,
  employee_id: 2,
  // Sarah Jenkins (HR Admin)
  work_date: '2026-11-12',
  current_state: 'CHECKED_OUT',
  check_in: '2026-11-12T09:00:00.000Z',
  check_out: '2026-11-12T18:00:00.000Z',
  total_work_minutes: 480,
  total_break_minutes: 60,
  status: 'PRESENT',
  notes: 'HR onboarding sessions'
}, {
  id: 7,
  employee_id: 3,
  // Michael Chen
  work_date: '2026-11-12',
  current_state: 'NOT_CHECKED_IN',
  check_in: null,
  check_out: null,
  total_work_minutes: 0,
  total_break_minutes: 0,
  status: 'ABSENT',
  notes: 'Unplanned absence'
}, {
  id: 8,
  employee_id: 4,
  // Priya Sharma
  work_date: '2026-11-12',
  current_state: 'CHECKED_OUT',
  check_in: '2026-11-12T09:30:00.000Z',
  check_out: '2026-11-12T18:30:00.000Z',
  total_work_minutes: 495,
  total_break_minutes: 45,
  status: 'PRESENT',
  notes: 'WFH approved'
}];
const breaksData = [{
  id: 1,
  attendance_id: 1,
  break_start: '2026-11-10T13:00:00.000Z',
  break_end: '2026-11-10T14:00:00.000Z',
  duration_minutes: 60
}, {
  id: 2,
  attendance_id: 2,
  break_start: '2026-11-11T11:30:00.000Z',
  break_end: '2026-11-11T12:00:00.000Z',
  duration_minutes: 30
}, {
  id: 3,
  attendance_id: 3,
  break_start: '2026-11-12T13:10:00.000Z',
  break_end: '2026-11-12T14:00:00.000Z',
  duration_minutes: 50
}];
const requestsData = [{
  id: 1,
  employee_id: 1,
  request_type: 'LEAVE',
  start_date: '2026-11-20',
  end_date: '2026-11-21',
  reason: 'Personal family emergency requiring travel.',
  status: 'PENDING',
  submission_date: '2026-11-14T10:15:00.000Z',
  decision_by: null,
  decision_date: null,
  decision_remarks: null
}, {
  id: 2,
  employee_id: 1,
  request_type: 'REGULARIZATION',
  start_date: '2026-11-09',
  end_date: '2026-11-09',
  reason: 'Forgot to punch out due to client emergency outage at 7:30 PM.',
  status: 'APPROVED',
  submission_date: '2026-11-10T08:30:00.000Z',
  decision_by: 6,
  decision_date: '2026-11-10T14:00:00.000Z',
  decision_remarks: 'Verified with engineering manager. Approved.'
}, {
  id: 3,
  employee_id: 2,
  // Sarah Jenkins (HR Admin's own request)
  request_type: 'WFH',
  start_date: '2026-11-18',
  end_date: '2026-11-18',
  reason: 'Home broadband fiber optic maintenance scheduled.',
  status: 'PENDING',
  submission_date: '2026-11-14T11:00:00.000Z',
  decision_by: null,
  decision_date: null,
  decision_remarks: null
}, {
  id: 4,
  employee_id: 3,
  // Michael Chen
  request_type: 'HOLIDAY',
  start_date: '2026-11-27',
  end_date: '2026-11-27',
  reason: 'Floating religious holiday observance request.',
  status: 'PENDING',
  submission_date: '2026-11-13T16:20:00.000Z',
  decision_by: null,
  decision_date: null,
  decision_remarks: null
}, {
  id: 5,
  employee_id: 4,
  // Priya Sharma
  request_type: 'LEAVE',
  start_date: '2026-11-05',
  end_date: '2026-11-06',
  reason: 'Attending Design Systems Global Summit 2026.',
  status: 'APPROVED',
  submission_date: '2026-10-28T09:00:00.000Z',
  decision_by: 6,
  decision_date: '2026-10-29T11:00:00.000Z',
  decision_remarks: 'Approved for professional development.'
}];
const notificationsData = [{
  id: 1,
  recipient_id: 1,
  title: 'Attendance Regularization Approved',
  message: 'Your regularization request for Nov 9 has been approved by Operations.',
  category: 'ATTENDANCE',
  is_read: false,
  created_at: '2026-11-10T14:05:00.000Z'
}, {
  id: 2,
  recipient_id: null,
  // Company-wide
  title: 'Thanksgiving Holiday Announcement',
  message: 'KNOOVIQ offices will observe company holiday on November 26, 2026.',
  category: 'HOLIDAY',
  is_read: false,
  created_at: '2026-11-01T09:00:00.000Z'
}, {
  id: 3,
  recipient_id: null,
  title: 'System Notice: Strict State-based Punches Enabled',
  message: 'Please ensure you record Check-in, Start Break, End Break, and Check-out sequentially.',
  category: 'ANNOUNCEMENT',
  is_read: true,
  created_at: '2026-11-05T08:00:00.000Z'
}, {
  id: 4,
  recipient_id: 2,
  title: 'WFH Request Submitted',
  message: 'Your Work-from-Home request for Nov 18 is pending Super Admin review.',
  category: 'REQUEST',
  is_read: false,
  created_at: '2026-11-14T11:00:00.000Z'
}];
const officeLocationData = [{
  id: 1,
  name: 'KNOOVIQ HQ, Bengaluru',
  latitude: 12.971598,
  longitude: 77.594566,
  radius_m: 50,
  max_accuracy_m: 50,
  address: 'KNOOVIQ Tech Tower, Outer Ring Rd, Bengaluru, Karnataka 560103',
  is_active: true,
  updated_by: 6,
  updated_at: new Date().toISOString()
}];

// Update local store
return {departments:departmentsData,employees:employeesData,holidays:holidaysData,attendances:attendancesData,attendance_breaks:breaksData,requests:requestsData,notifications:notificationsData,office_locations:officeLocationData};
}
