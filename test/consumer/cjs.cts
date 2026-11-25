// CommonJS consumers can require() the package (Node 22.12+ loads ES modules from require).
import coursekit = require('coursekit-lms');

const create: typeof coursekit.createCoursekit = coursekit.createCoursekit;
void create;
