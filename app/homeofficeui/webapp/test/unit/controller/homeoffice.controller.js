/*global QUnit*/

sap.ui.define([
	"sabnez/com/homeofficeui/controller/homeoffice.controller"
], function (Controller) {
	"use strict";

	QUnit.module("homeoffice Controller");

	QUnit.test("I should test the homeoffice controller", function (assert) {
		var oAppController = new Controller();
		oAppController.onInit();
		assert.ok(oAppController);
	});

});
