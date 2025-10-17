// Example: Binary File Serving with MasterController
//
// This example demonstrates how to use the returnFile() method
// to serve binary files in your MasterController application.

class ExampleController extends MasterAction {

	// Example 1: Serve a PDF file for download
	downloadPdf(){
		var filePath = master.root + '/storage/documents/report.pdf';
		this.returnFile(filePath);
		// Downloads as 'report.pdf' with auto-detected content-type
	}

	// Example 2: Display an image inline
	showImage(){
		var filePath = master.root + '/storage/images/photo.jpg';
		this.returnFile(filePath, {
			disposition: 'inline'  // Display in browser instead of download
		});
	}

	// Example 3: Serve file with custom filename
	downloadReport(){
		var filePath = master.root + '/storage/reports/monthly-2024-01.pdf';
		this.returnFile(filePath, {
			filename: 'January_Report.pdf'  // Custom filename for download
		});
	}

	// Example 4: Serve file with explicit content type
	downloadCsv(){
		var filePath = master.root + '/storage/exports/data.csv';
		this.returnFile(filePath, {
			contentType: 'text/csv',
			filename: 'export.csv'
		});
	}

	// Example 5: Serve dynamic file based on user request
	downloadUserFile(){
		var fileId = this.params.id;
		var filePath = master.root + '/storage/user-files/' + fileId;

		// You might want to add authentication/authorization checks here
		// if (this.session.userId !== file.ownerId) { ... }

		this.returnFile(filePath, {
			filename: 'user-document.pdf'
		});
	}

	// Example 6: Serve images inline (for img src tags)
	serveUserAvatar(){
		var userId = this.params.id;
		var avatarPath = master.root + '/storage/avatars/' + userId + '.png';
		this.returnFile(avatarPath, {
			disposition: 'inline',
			contentType: 'image/png'
		});
	}

}

module.exports = ExampleController;


// Supported MIME types (auto-detected by file extension):
//
// Images: jpg, jpeg, png, gif, svg
// Documents: pdf, doc, docx, xls, xlsx, ppt, pptx
// Data: csv, json, xml, txt
// Archives: zip
// Media: mp3, mp4, wav
//
// For other file types, use contentType option or files will be served as 'application/octet-stream'


// Route configuration example:
// In your routes.js:
//
// {
//   "url" : "/download/pdf",
//   "namespace" : "example",
//   "controller" : "ExampleController",
//   "action" : "downloadPdf",
//   "type" : "GET"
// }
