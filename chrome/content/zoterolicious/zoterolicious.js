
var Zoterolicious =  new function () {
	/*
	 * Initialize the extension
	 */
	
	var queuedDeliciousItems;
	var syncProgress;
	var notifierID;

	this.init = init;
	this.unload = unload;
	function init() {

		// Register the callback in Zotero as an item observer
		notifierID = Zotero.Notifier.registerObserver(ZoteroliciousnotifierCallback, ['item']);

		// Unregister callback when the window closes (important to avoid a memory leak)
		window.addEventListener('unload', 
									function(e) {
											Zotero.Notifier.unregisterObserver(notifierID);
									}, 
									false);

		this.DB = new Zotero.DBConnection('Zoterolicious'); 

		// Check if the table exists, and if it does not, create it.
		if( !this.DB.tableExists('zoterolicious') ){
			// TODO: probably can change this to use a preference rather than accessing the database
			this.DB.beginTransaction();
			var sql = "CREATE TABLE zoterolicious (lastsync DATETIME DEFAULT CURRENT_TIMESTAMP); "
			+ "INSERT INTO zoterolicious (lastsync) VALUES('1990-01-01 12:00:00')";
			this.DB.query(sql);
			this.DB.commitTransaction();	
	
			Zoterolicious.debug("Zoterolicious: Zoterolicious installed.");
		}
	}
	function unload() {
		Zotero.Notifier.unregisterObserver(notifierID);
	}
	
}

Zoterolicious.debug = function(string) {
	Zotero.debug("Zoterolicious: " + string);
}

/*
*	Makes an XMLHTTPRequest to the del.icio.us API, using basic authentication.
*/
Zoterolicious.deliciousAPI = function(command, http) {
	if(Zotero.Prefs.get('zoteroliciousActivated')) {
		http = new XMLHttpRequest();
		Zoterolicious.debug("Zoterolicious: del.icio.us API: " + command);
		// Do the del.icio.us action, depending on the user event.
		if(http) {
			http.open("get", command, false, Zotero.Prefs.get('zoteroliciousUsername'), Zotero.Prefs.get('zoteroliciousPassword'));
			http.send("");
			if (http.status == 200) {
		        document.location = this.action;
				return http.responseXML;
		    } else {
		        alert(document.getElementById('zoterolicious-strings').
					getFormattedString('delicious.incorrectUsernamePassword', []));
				return -1;
		    } 
		}
		return "";
	}
	else {
		return -1;
	}
}

/*
 * Creates Zotero.Translate instance and shows file picker for file import
 */
Zoterolicious.sync = function() {
	
	// Get the last time Zoterolicious was sync'd with del.icio.us
	var lastsync = Zotero.DB.valueQuery("SELECT * from zoterolicious LIMIT 1");
	
	lastsync = Zotero.Date.sqlToDate(lastsync);
	

	var delicioussync = lastsync.getFullYear() + "-" 
							+ (lastsync.getMonth() + 1) + "-" 
							+ (lastsync.getDate()) + "T" 
							+ lastsync.getHours() + ":" 
							+ lastsync.getMinutes() + ":" 
							+ lastsync.getSeconds() + "Z";

	Zoterolicious.debug("Zoterolicious: lastsync " + delicioussync + "( " + lastsync +" )");
	
	// Get the items that will be added to del.icio.us
	var newItems = Zoterolicious.uploadNewItems();
	// Now get the new items *from* del.icio.us
	var rv = Zoterolicious.downloadNewItems(delicioussync);
	if(rv == -1) {
			return -1;
	}

	// Finally add what were the new items from Zotero to del.icio.us
	rv = Zoterolicious.postToDelicious(newItems);
	if(rv == -1) {
			return -1;
	}
	Zotero.DB.query("UPDATE zoterolicious SET lastsync = datetime('now') ");
	Zotero.Prefs.set("zoteroliciousLastSync", delicioussync)

	return 0;
}

/* Generic function used to check if values are in an array
* from: http://snook.ca/archives/javascript/testing_for_a_v/
*/
Zoterolicious.oc = function (a)
{
  var o = {};
  for(var i=0;i<a.length;i++)
  {
    o[a[i]]='';
  }
  return o;
};

/*
*	Upload items that are newer in Zotero than Del.icio.us
*/
Zoterolicious.uploadNewItems = function() {
	var str = document.getElementById('zoterolicious-strings').
		getFormattedString('delicious.lastUpdate', []);
	var lastpost_xml = Zoterolicious.deliciousAPI(str);
	if(lastpost_xml == -1) {
		return null;
	}
	
	var lastpost = (lastpost_xml.getElementsByTagName('update'))[0].getAttribute('time');
	lastpost = lastpost.replace(/T/," ").replace(/Z$/,"");
	
	Zoterolicious.debug("Zoterolicious: Del.icio.us lastpost: " + lastpost);
		
	var sql = "SELECT * FROM items WHERE dateAdded >= '" + lastpost + "'";
	var newItemsIds = Zotero.DB.columnQuery(sql);

	// TODO: figure out how to prevent throttling by del.icio.us for > 1 post/sec
	return Zotero.Items.get(newItemsIds);
}

/*
*	Retrieves the newest items from del.icio.us
TODO: add datetime formatting to del.icio.us request
*/
Zoterolicious.downloadNewItems = function(lastsync){
	var str = document.getElementById('zoterolicious-strings').
		getFormattedString('delicious.getPosts', [])
			+ "dt=" + lastsync;

	var newItemsXML = Zoterolicious.deliciousAPI(str);
	
	if(newItemsXML == -1) {
		return -1;
	}
	
	var posts = newItemsXML.getElementsByTagName('post')
	var cutOffDate = Zotero.Date.sqlToDate(lastsync.replace(/T/," ").replace(/Z$/,""), true);

	// Walk through all new items and add to the Zotero database
	for (var i=0, len=posts.length; i<len; i++){
		Zoterolicious.deliciousToDB(posts[i], cutOffDate);
	}
	return 0;
}

/*
* Checks the black list or white list to see if the tag is on it
*
* @param tags an array of tags to check against the white or black list
* @param listType list to use to check ("Black", "White"), default is "Black"
*/
Zoterolicious.blackListedItem = function(tags, listType) {
	if(!listType) {
		listType = "Black";
	}
	var tags_array = Zoterolicious.oc(tags);
	// 	check length b/c otherwise there is a single element in the array 
	if(Zotero.Prefs.get('zoterolicious' + listType + 'list') 
		&& Zotero.Prefs.get('zoterolicious' + listType + 'list').length > 0) {
		var checkList = Zotero.Prefs.get('zoterolicious' + listType + 'list').split(/[ ,]+/);
		for (var checkTag in checkList) {
			if((checkTag in tags_array) && (checkTag != "")) {
				Zoterolicious.debug("Zoterolicious: Item is on the " + listType + "list: " + whiteTag);
				return true;
			}
		}
	}	
	else {
		// there is an empty whitelist - so everything is approved
		if(listType == "White") {
			return true;
		}
	}	
	return false;
}

/** 
	Converts the del.icio.us response to Zotero DB items.
	
Example:
<posts dt="2005-11-28" tag="webdev" user="user">
  <post href="http://www.howtocreate.co.uk/tutorials/texterise.php?dom=1" 
  description="JavaScript DOM reference" 
  extended="dom reference" 
  hash="c0238dc0c44f07daedd9a1fd9bbdeebd" 
  others="55" tag="dom javascript webdev" time="2005-11-28T05:26:09Z" />
</posts>
*/
Zoterolicious.deliciousToDB = function(xmlnode, lastsync) {
	xmlnode.normalize();

	var item = null;
	var tags = xmlnode.getAttribute('tag').split(' ');
	var datetime = Zotero.Date.sqlToDate(
				xmlnode.getAttribute('time').replace(/T/," ").replace(/Z$/,""), true);
	
	if(datetime > lastsync) {
		// check the Blacklist for not syncing this item
		if(Zoterolicious.blackListedItem(tags)) {
			return null;
		}
	
		item = new Zotero.Item('webpage');
		item.setField('url', xmlnode.getAttribute('href'));
		item.setField('title', xmlnode.getAttribute('description'));
	
		// Save the item so we can tags and notes
		Zotero.DB.beginTransaction();
		var id = item.save();
		Zotero.DB.commitTransaction();

		// Have to re-get the item in order to save the tags & the note
		item = Zotero.Items.get(id);
		Zotero.Notes.add(xmlnode.getAttribute('extended'), id)

		for each(var tag in tags) {
			item.addTag(tag, 0); // 0 for regular tags and 1 for automatic
		}
	}
	
	return item;
}


Zoterolicious._postCallback = function() {
	var str = "";
	var tags;
	Zoterolicious.debug("Zoterolicious: _postCallback called ["+Zoterolicious.queuedDeliciousItems.length+"]");
	
	var item = Zoterolicious.queuedDeliciousItems.pop();
	
	// keep cycling until we get an item that we want to sync.
	while(item && item.getType() != 13) {
		Zoterolicious.debug("Zoterolicious: item not a webpage, it's a " + item.getType());
		item = Zoterolicious.queuedDeliciousItems.pop();
	}
	if(!item) {
		// done with items, re-activate the sync option
		// 	and get rid of the progress window
		Zoterolicious.syncProgress.fade();
		document.getElementById("zoterolicious-sync").disabled = false;
		return;
	}
	else {
		var title = item.getField("title");
		var icon = item.getImageSrc();
		Zoterolicious.syncProgress.addLines([title], [icon]);
		
		// Build an array of the tags actual tag name
		tags = item.getTags();
		var tagTags = new Array();
		if(tags) {
			for(var i = 0; i < tags.length; i++) {
				tagTags.push(tags[i].tag);
			}
		}

		// Check the white and black lists
		if(Zoterolicious.blackListedItem(tagTags) 
			|| !(Zoterolicious.blackListedItem(tagTags, "White")) ) {
			return;
		}

		// Build the del.icio.us API call
		str = document.getElementById('zoterolicious-strings').
			getFormattedString('delicious.addPost', []) 
				+ "url=" + item.getField('url')
				+ "&description=" + item.getField('title')
				+ "&extended=" + item.getField('description');
		if(tags) {
			str = str + "&tags=" + tagTags.join(" ");
		}

		Zoterolicious.debug("Zoterolicious: del.icio.us api call " + str);
		if( Zoterolicious.deliciousAPI(str) == -1) {
			return;
		}

		// finished posting this item, call it again in 1 second
		setTimeout(Zoterolicious._postCallback,1500);
	}
}

/*
*	Upload items to del.icio.us

	TODO: Add error handling to del.icio.us posting
*/
Zoterolicious.postToDelicious = function(items) {
	
	if(!items || items.length == 0) {
		return 0;
	}
	
	// Del.icio.us has throttling, so space out updates to 
	//	approx 1/second by using a timeout function: _postCallback()
	document.getElementById("zoterolicious-sync").disabled = true;
	
	Zoterolicious.syncProgress = new Zotero.ProgressWindow(); 
	Zoterolicious.syncProgress.changeHeadline(document.getElementById('zoterolicious-strings').
		getFormattedString('delicious.syncingToDelicious', []));
	Zoterolicious.syncProgress.show();

	Zoterolicious.debug("Zoterolicious: Posting " + items.length + " items to del.icio.us")
	Zoterolicious.queuedDeliciousItems = items;
	Zoterolicious._postCallback();
	
	return 0;

}

/* 
* Callback implementing the notify() method to pass to the Notifier
*/
var ZoteroliciousnotifierCallback = {
	notify: function(event, type, ids, oldobjects) {

		if(Zotero.Prefs.get('zoteroliciousActivated')) {

			// Currently only handle items (vs. ?)
			if(type == "item") {
				if (event=='add' || event=='modify') {
					// Retrieve the added/modified items as Item objects
					var items = Zotero.Items.get(ids);
					Zoterolicious.postToDelicious(items);
				}
		
				else if (event=='delete') {
					// delete notification passes an array of the old object data
					for each(var item in oldobjects) {
			
						var str = document.getElementById('zoterolicious-strings').
								getFormattedString('delicious.deletePost', []) 
									+ "url=" + item.old['url'];
						Zoterolicious.deliciousAPI(str);

					}
				} // end event type
			} // end item type==13
		} // end zoteroliciousActivated prefs
	}
};

// Initialize Zoterolicious after the window loads
window.addEventListener('load', function(e) {
	Zoterolicious.init();
}, false);

// Unregister callback when the window closes (important to avoid a memory leak)
window.addEventListener('unload', function(e) {
	Zoterolicious.unload();
}, false);

