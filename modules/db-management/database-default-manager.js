// This is designed to run as it's own process
// It takes in a json array
//  {
//    "username":"lol",
//    "userDir":"/Users/psori/Desktop/Blockhead",
//    "dbSettings":{
//     "type":"sqlite",
//     "dbPath":"/Users/psori/Desktop/LATESTGREATEST.DB"
//    }
//    "albumArtDir": "/album/art/dir"
// }

// Parse input JSON
try{
  var loadJson = JSON.parse(process.argv[process.argv.length-1], 'utf8');
}catch(error){
  console.log('Cannot parse JSON input');
  process.exit();
}

// Libraries
const metadata = require('music-metadata');
const fs = require('fs');
const fe = require('path');
const crypto = require('crypto');

// Setup DB layer
// The DB functions are dcoupled from this so they can easily be swapped out
const dbRead = require('../db-write/database-default-loki.js');

// Global Vars
var globalCurrentFileList = {};  // Map of file paths to metadata
var listOfFilesToParse = [];
var listOfFilesToDelete = [];

// Start the generator
const parseFilesGenerator = rescanAllDirectories(loadJson.userDir);
parseFilesGenerator.next();

// Scan the directory for new, modified, and deleted files
function *rescanAllDirectories(directoryToScan){
  yield dbRead.setup(loadJson.dbSettings.dbPath, function(){
    parseFilesGenerator.next();
  });
  // Pull filelist from DB
  pullFromDB();
  // Loop through current files and compare them to the files pulled from the DB
  recursiveScan(directoryToScan);
  // Delete Files
  for (var i=0; i < listOfFilesToDelete.length; i++) {
    deleteFile(listOfFilesToDelete[i]);
  }
  // Delete all remaining files
  for (var file in globalCurrentFileList) {
    deleteFile(file);
  }
  // Parse and add files to DB
  for (var i=0; i < listOfFilesToParse.length; i++) {
    yield parseFile(listOfFilesToParse[i]);
  }

  yield dbRead.savedb(function(){
    parseFilesGenerator.next();
  })
  // Exit
  process.exit(0);
}

// Get all files form DB and add to globalCurrentFileList
function pullFromDB(){
  dbRead.getUserFiles(loadJson, function(rows){
    for(var s of rows){
      globalCurrentFileList[s.filepath] = s;
    }
  });
}


function recursiveScan(dir, fileTypesArray){
  var files = fs.readdirSync( dir );

  // loop through files
  for (var i=0; i < files.length; i++) {
    var filepath = fe.join(dir,  files[i]);
    try{
      var stat = fs.statSync(filepath);
    }catch(error){
      // Bad file, ignore and continue
      continue;
    }

    if(stat.isDirectory()){
      recursiveScan(filepath);
    }else{
      // Make sure this is in our list of allowed files
      var extension = getFileType(files[i]);
      var fileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];
      if (fileTypesArray.indexOf(extension) === -1 ) {
        continue;
      }

      // Check if in globalCurrentFileList
      if (!(filepath in globalCurrentFileList)){
        // if not parse new file, add it to DB, and continue
        listOfFilesToParse.push(filepath);
        continue;
      }

      // check the file_modified_date
      if(stat.mtime.getTime() !== globalCurrentFileList[filepath].modified){
        listOfFilesToParse.push(filepath);
        listOfFilesToDelete.push(filepath);
      }

      // Remove from globalCurrentFileList
      delete globalCurrentFileList[filepath];
    }
  }
}



function parseFile(thisSong){
  var filestat = fs.statSync(thisSong);
  if(!filestat.isFile()){
    // TODO: Something is fucky, log it
    console.log('BAD FILE');
    parseFilesGenerator.next();
    return;
  }

  // Parse the file for metadata and store it in the DB
  return metadata.parseFile(thisSong).then(function (thisMetadata) {
      var songInfo = thisMetadata.common;
      songInfo.filesize = filestat.size;
      songInfo.created = filestat.birthtime.getTime();
      songInfo.modified = filestat.mtime.getTime();
      songInfo.filePath = thisSong;
      songInfo.format = getFileType(thisSong);
      return songInfo;
    }).then(function (songInfo) {
      // Calculate unique DB ID
      return calculateHash(thisSong, songInfo);
    }).then(function (songInfo) {
      // Stores metadata of song in the database
      return dbRead.insertEntries([songInfo], loadJson.username)
    }).then(function () {
      // Continue with next file
      parseFilesGenerator.next();
    }).catch(function (err) {
      console.log("Warning: failed to parse file '%s': %s", thisSong, err.message);
      parseFilesGenerator.next();
    });
}

function calculateHash (thisSong, songInfo) {
  return new Promise(function (resolve, reject) {
    // Handle album art
    //  TODO: handle cases where multiple images in metadata
    var bufferString = false;
    var picFormat = false;
    if (songInfo.picture && songInfo.picture[0]) {
      bufferString = songInfo.picture[0].data.toString('utf8');
      picFormat = songInfo.picture[0].format;
    } else if (false) { // TODO: Check if there is album art in base folder

    }


    // Hash the file here and add the hash to the DB
    var hash = crypto.createHash('sha256');
    hash.setEncoding('hex');
    var readableStream2 = fs.createReadStream(thisSong);

    readableStream2.on('end', function () {
   	  hash.end();
      readableStream2.close();

      songInfo.hash = String(hash.read());

      if(bufferString !== false){
        // Generate unique name based off hash of album art and metadata
        var picHashString = crypto.createHash('sha256').update(bufferString).digest('hex');
        songInfo.albumArtFilename = picHashString + '.' + picFormat;
        // Cehck image-cache folder for filename and save if doesn't exist
        if (!fs.existsSync(fe.join(loadJson.albumArtDir, songInfo.albumArtFilename))) {
          // Save file sync
          fs.writeFileSync(fe.join(loadJson.albumArtDir, songInfo.albumArtFilename), songInfo.picture[0].data);
        }
      }

      resolve(songInfo);
    });

    readableStream2.pipe(hash);
  });
}

function deleteFile(filepath){
  dbRead.deleteFile(filepath, loadJson.username, function(){  });
}

function getFileType(filename){
  return filename.split(".").pop();
}
