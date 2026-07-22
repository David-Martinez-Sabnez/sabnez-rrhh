sap.ui.require(
    [
        'sap/fe/test/JourneyRunner',
        'sabnez/com/homeofficeadminui/test/integration/FirstJourney',
		'sabnez/com/homeofficeadminui/test/integration/pages/ReporteHomeOfficeList',
		'sabnez/com/homeofficeadminui/test/integration/pages/ReporteHomeOfficeObjectPage'
    ],
    function(JourneyRunner, opaJourney, ReporteHomeOfficeList, ReporteHomeOfficeObjectPage) {
        'use strict';
        var JourneyRunner = new JourneyRunner({
            // start index.html in web folder
            launchUrl: sap.ui.require.toUrl('sabnez/com/homeofficeadminui') + '/index.html'
        });

       
        JourneyRunner.run(
            {
                pages: { 
					onTheReporteHomeOfficeList: ReporteHomeOfficeList,
					onTheReporteHomeOfficeObjectPage: ReporteHomeOfficeObjectPage
                }
            },
            opaJourney.run
        );
    }
);